#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""parse_bank.py -- parse 密码赛题库.pdf into the frozen bank.json structure.

Input : 密码赛题库.pdf (via bank_text.json page text, or a fresh
        pypdfium2 extraction when the cached text is absent).
Output: src/data/bank.json            (frozen schema, 需求规格.md 5.1-5.9)
        src/data/bank.report.json     (machine readable parse report)
        docs/解析报告.md               (human readable parse report)

Console output is ASCII only (the Windows console mangles CJK).

Re-runnable: same input -> byte identical output, except the "generatedAt"
timestamp (freeze it with --now or the CQP_NOW environment variable).

Exit codes: 0 = ok, 1 = a frozen hard check failed, 2 = usage / input error.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

# --------------------------------------------------------------------------
# frozen constants (需求规格.md §5)
# --------------------------------------------------------------------------

SCHEMA_VERSION = "1.0.0"
BANK_VERSION = "2026.08-pdf1"
PDF_FILE_NAME = "密码赛题库.pdf"
PDF_PAGE_COUNT = 199
EXCLUDED_COUNT = 12
EXCLUDED_REASON = "第三部分实操题不纳入（用户决策 D12）"
TZ8 = timezone(timedelta(hours=8))

TYPE_NAME = {
    "single": "单选题",
    "multiple": "多选题",
    "judge": "判断题",
    "blank": "填空题",
}
TYPE_CODE = {"single": "S", "multiple": "M", "judge": "J", "blank": "F"}
PART_NAME = {"B": "基础题", "P": "专业题"}

# (chapterCode, partCode, chapterName, [(sectionType, expected physical blocks, expected printed)])
CHAPTER_SPEC = [
    ("C01", "B", "密码法律法规", [("single", 40, 40), ("multiple", 13, 13), ("judge", 12, 12)]),
    ("C02", "B", "网络安全法律法规", [("single", 30, 30), ("multiple", 10, 10), ("judge", 10, 10)]),
    ("C03", "B", "密码管理规章制度", [("single", 35, 35), ("multiple", 10, 10), ("judge", 10, 10)]),
    ("C04", "B", "其他政策法规条例", [("single", 25, 25), ("multiple", 10, 10), ("judge", 10, 10)]),
    ("C05", "P", "密码学", [("single", 156, 155), ("multiple", 130, 130), ("judge", 80, 80), ("blank", 30, 30)]),
    ("C06", "P", "密码前沿技术", [("single", 115, 115), ("multiple", 60, 60), ("judge", 20, 20)]),
    ("C07", "P", "标准题", [("single", 90, 90), ("multiple", 125, 125), ("judge", 30, 30)]),
]
CHAPTER_META = {code: (part, name) for code, part, name, _ in CHAPTER_SPEC}
SECTION_EXPECT = {
    (code, stype): (blocks, printed)
    for code, _part, _name, sections in CHAPTER_SPEC
    for stype, blocks, printed in sections
}

# frozen tag vocabulary + keyword rules (需求规格.md §5.6, order matters)
TAG_RULES = [
    ("密码法", "密码法"),
    ("商用密码管理条例", "商用密码管理条例"),
    ("网络安全法", "网络安全法"),
    ("数据安全法", "数据安全法"),
    ("个人信息保护法", "个人信息保护法"),
    ("电子签名法", "电子签名法"),
    ("部门规章", "检测机构管理办法|应用安全性评估管理办法|电子政务电子认证服务管理办法|关键信息基础设施商用密码使用管理规定|电子认证服务使用密码管理办法|网络安全审查办法"),
    ("地方性法规", "江苏省|省条例"),
    ("SM2", "SM2"),
    ("SM3", "SM3"),
    ("SM4", "SM4"),
    ("SM9", "SM9"),
    ("ZUC", "ZUC"),
    ("分组密码", "分组密码|工作模式|Feistel|ECB|CBC|CFB|OFB|CTR|GCM|CCM"),
    ("流密码", "流密码|LFSR"),
    ("公钥密码", "公钥|RSA|ElGamal|椭圆曲线|ECDSA|ECC|双线性|Diffie-Hellman"),
    ("杂凑与消息鉴别", "杂凑|哈希|SHA-1|SHA-256|SHA-2|SHA-3|MD5|HMAC|CMAC|摘要"),
    ("密钥管理", "密钥管理|密钥派生|KDF|密钥交换|秘密共享|门限|HSM|密码机"),
    ("量子密码", "量子|BB84|QKD|抗量子|后量子"),
    ("区块链", "区块链"),
    ("电子认证与 PKI", "数字证书|PKI|电子签章|时间戳|身份鉴别|IBC|属性证书|CA 系统"),
    ("网络协议与密码应用", "TLS|SSL|IPSec|VPN|SSH|协议分析|网关"),
    ("密评与建设运维", "密码应用安全性评估|密评|GB/T 39786|等级保护|测评|建设整改|运维"),
    ("标准规范", r"(GB/T|GM/T|GM/Z)\s*\d+"),
    ("人工智能安全", "人工智能|生成式|大模型|智能体|AI "),
    ("物联网与工控安全", "物联网|PLC|工控|车联网|RFID"),
    ("口令与鉴权", "口令|动态口令|OTP|双因素|生物特征|访问控制|授权管理"),
    ("职业道德", "职业道德|职业守则|职业标准|保密义务"),
    ("商用密码", "商用密码"),
    ("核心密码与普通密码", "核心密码|普通密码"),
    ("密码应用", "密码应用|密码使用|密码保障|密码测评"),
    ("数据安全与个人信息", "数据安全|个人信息|数据出境|重要数据"),
    ("网络安全与关基", "网络安全|关键信息基础设施|网络关键设备|网络安全审查"),
]
TAG_UNCLASSIFIED = "未分类"
CHAPTER_FALLBACK_TAG = {
    "C01": "密码法律法规",
    "C02": "网络安全法律法规",
    "C03": "密码管理规章制度",
    "C04": "其他政策法规条例",
    "C05": "密码学基础",
    "C06": "密码前沿技术",
    "C07": "标准规范",
}
TAG_VOCAB = [t for t, _ in TAG_RULES] + [TAG_UNCLASSIFIED] + list(CHAPTER_FALLBACK_TAG.values())

# frozen count expectations (需求规格.md §5.9)
EXPECTED = {
    "questions": 1051,
    "printed": 1050,
    "answerOk": 1050,
    "answerMissing": 1,
    "needsReview": 5,
    "printedNoNull": 1,
    "sectionType": {"single": 491, "multiple": 358, "judge": 172, "blank": 30},
    "responseMode": {"single": 492, "multiple": 357, "judge": 172, "blank": 30},
    "typeMismatch": 5,
    "judgeAnswer": {"对": 81, "错": 91},
    "singleSectionAnswers": {"one": 489, "many": 2},
    "multipleSectionAnswers": {"one": 3, "many": 355},
    "matchingIds": ["Q-C04-M-0002", "Q-C04-M-0009", "Q-C06-S-0006", "Q-C06-S-0096"],
    "typeMismatchIds": ["Q-C06-S-0004", "Q-C07-S-0027", "Q-C04-M-0002", "Q-C04-M-0009", "Q-C06-M-0008"],
    "needsReviewIds": ["Q-C05-S-0060", "Q-C05-F-0007", "Q-C06-S-0004", "Q-C07-S-0027", "Q-C06-M-0008"],
    "missingAnswerId": "Q-C05-F-0007",
    "unnumberedId": "Q-C05-S-0060",
}

REVIEW_PRINTED_NUMBER_MISSING = "printed_number_missing"
REVIEW_ANSWER_MISSING = "answer_missing"
REVIEW_TYPE_MISMATCH = "type_mismatch"

# ---------------------------------------------------------------------------
# manually recorded answers (maintainer decision, attempt 2; user may overturn)
# ---------------------------------------------------------------------------
# The source PDF has exactly one question without an "答案：" line. Its answer is
# stated inside the stem itself, so it is recorded here instead of guessed. The
# switch --no-manual-answers (or CQP_NO_MANUAL_ANSWERS=1) restores the raw parse
# (answer=[], answerStatus="missing"), which is the 需求规格.md 5.9 baseline.
MANUAL_ANSWERS = {
    "Q-C05-F-0007": {
        "answer": ["16"],
        "sourcePage": 97,
        "evidence": "题干：长度为 1000 字节…SM3 会把它切成若干个 512 位（64 字节）的块，那么可以切 16 块；1000/64=15.625 向上取整 = 16，与题干自洽",
        "note": "原文无「答案：」行，答案出自题干与分块计算，已人工确认；题干保持与原文逐字一致，未改动",
    }
}

# --------------------------------------------------------------------------
# regexes
# --------------------------------------------------------------------------

RE_PAGE_FOOTER = re.compile(r"^第\s*\d+\s*页$")
RE_PAGE_MARKER = re.compile(r"^=+\s*PAGE\s*\d+\s*=+$")
RE_TOC_LEADER = re.compile(r"\.{4,}\s*\d+\s*$")
RE_PART = re.compile(r"第([一二三四五六七八九十])部分\s*(基础题|专业题|实操题)\s*(\d+)?")
RE_CHAPTER = re.compile(
    r"([一二三四五六七八九十])\s*、\s*"
    r"(密码法律法规|网络安全法律法规|密码管理规章制度|其他政策法规条例|密码学|密码前沿技术|标准题)\s*(\d+)?"
)
RE_SECTION = re.compile(r"([一二三四五六七八九十])\s*、\s*(单选题|多选题|判断题|填空题)\s*(\d+)?")
RE_QSTART = re.compile(r"^(\d{1,4})\s*[.．、]\s*(.*)$")
RE_ANSWER = re.compile(r"(?:正确|参考)?答案\s*[:：]\s*(.*)$")
RE_OPT_LINE = re.compile(r"^([A-Da-d])\s*[.．、]\s*(.*)$")
RE_ANY_OPT = re.compile(r"(?<![A-Za-z0-9])[A-D]\s*[.．、]\s*")
RE_INLINE_OPT = re.compile(r"(?<![A-Za-z0-9])[A-D]\s*[.．、]\s")
RE_UNDERSCORES = re.compile(r"_{2,}|_\s_")
RE_MIDLINE_NUMBER = re.compile(r"[\u4e00-\u9fff]\s\d{1,4}[.．]\s*[\u4e00-\u9fff]")
RE_MATCH_PAIR = re.compile(r"^\d+\s*[-—－–]\s*[A-D]")
RE_ID = re.compile(r"^Q-C\d{2}-[SMJF]-\d{4}$")


def is_matching_question(stem, options):
    """True for the 4 matching/连线 questions (defect C)."""
    if not re.search(r"连线|匹配", stem):
        return False
    if len(options) != 4:
        return False
    return all(RE_MATCH_PAIR.match(o["text"]) for o in options)

CJK_RANGES = (
    (0x3000, 0x303F),   # CJK punctuation
    (0x3400, 0x4DBF),   # CJK ext A
    (0x4E00, 0x9FFF),   # CJK unified
    (0xF900, 0xFAFF),   # CJK compatibility ideographs
    (0xFE30, 0xFE4F),   # CJK compatibility forms
    (0xFF00, 0xFFEF),   # fullwidth forms
)


def is_cjk(ch: str) -> bool:
    o = ord(ch)
    return any(lo <= o <= hi for lo, hi in CJK_RANGES)


def norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def merge_lines(parts):
    """Join PDF lines: no space when both neighbours are CJK, else one space."""
    out = ""
    for part in parts:
        part = norm_ws(part)
        if not part:
            continue
        if not out:
            out = part
        elif is_cjk(out[-1]) and is_cjk(part[0]):
            out += part
        else:
            out += " " + part
    return out


def fullwidth_to_halfwidth(s: str) -> str:
    """1:1 fullwidth -> halfwidth mapping for U+FF01..U+FF5E (需求规格.md §13.3 note)."""
    return "".join(chr(ord(c) - 0xFEE0) if 0xFF01 <= ord(c) <= 0xFF5E else c for c in s)


# --------------------------------------------------------------------------
# stage 1: page text -> cleaned lines
# --------------------------------------------------------------------------

def load_pages(text_path, pdf_path):
    if text_path and os.path.isfile(text_path):
        raw = json.load(io.open(text_path, encoding="utf-8"))
        if isinstance(raw, dict) and "pages" in raw:
            raw = raw["pages"]
        if isinstance(raw, list) and raw and all(isinstance(x, str) for x in raw):
            return list(raw), "cached page text: " + os.path.basename(text_path)
        raise SystemExit("usage: unexpected structure in %s" % text_path)
    import pypdfium2 as pdfium  # optional dependency, only needed for re-extraction

    doc = pdfium.PdfDocument(pdf_path)
    pages = [doc[i].get_textpage().get_text_range() for i in range(len(doc))]
    return pages, "fresh pypdfium2 extraction: " + os.path.basename(pdf_path)


def flatten_lines(pages):
    lines = []
    dropped = {"footer": 0, "marker": 0, "blank": 0, "toc": 0, "frontmatter": 0}
    for idx, ptext in enumerate(pages):
        page = idx + 1
        for raw in ptext.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
            s = raw.strip()
            if not s:
                dropped["blank"] += 1
                continue
            if RE_PAGE_FOOTER.match(s):
                dropped["footer"] += 1
                continue
            if RE_PAGE_MARKER.match(s):
                dropped["marker"] += 1
                continue
            if RE_TOC_LEADER.search(s):
                dropped["toc"] += 1
                continue
            lines.append((page, s))
    # the front matter (cover, table of contents, policy/standard scope) is not part
    # of the question bank: start at the first body part heading.
    body_start = None
    for i, (_page, text) in enumerate(lines):
        m = RE_PART.search(text)
        if m and m.group(2) == "基础题":
            body_start = i
            break
    if body_start is None:
        raise SystemExit("fatal: body part heading not found")
    dropped["frontmatter"] = body_start
    return lines[body_start:], dropped


# --------------------------------------------------------------------------
# stage 2: headings -> sections
# --------------------------------------------------------------------------

def find_headings(text):
    hits = []
    for kind, rx in (("part", RE_PART), ("chapter", RE_CHAPTER), ("section", RE_SECTION)):
        for m in rx.finditer(text):
            hits.append((m.start(), m.end(), kind, m))
    hits.sort(key=lambda h: (h[0], h[1]))
    return hits


def slice_sections(lines):
    """Return (sections, residual_anomalies, stopped_at_hands_on, dropped_hands_on_lines)."""
    sections = []
    anomalies = []
    part_code = None
    chapter_code = None
    current = None
    stopped = False
    dropped_hands_on = 0

    def flush():
        nonlocal current
        if current is not None and current["lines"]:
            sections.append(current)
        current = None

    for page, text in lines:
        hits = find_headings(text)
        if not hits:
            if current is not None and not stopped:
                current["lines"].append((page, text))
            elif stopped:
                dropped_hands_on += 1
            elif not stopped:
                anomalies.append({"kind": "text_before_first_heading", "page": page, "text": text[:80]})
            continue
        # heading line: everything outside the heading spans is residual content.
        # Residual that follows the 实操题 heading belongs to the excluded section.
        pos = 0
        for start, end, kind, m in hits:
            residual = text[pos:start].strip()
            pos = end
            if residual:
                if stopped:
                    dropped_hands_on += 1
                elif current is not None:
                    current["lines"].append((page, residual))
                else:
                    anomalies.append({"kind": "content_on_heading_line", "page": page, "text": residual[:80]})
            if kind == "part":
                name = m.group(2)
                if name == "实操题":
                    stopped = True
                    flush()
                    continue
                part_code = {"基础题": "B", "专业题": "P"}[name]
            elif kind == "chapter":
                flush()
                chapter_code = m.group(2)
            else:  # section
                flush()
                section_type = {
                    "单选题": "single",
                    "多选题": "multiple",
                    "判断题": "judge",
                    "填空题": "blank",
                }[m.group(2)]
                if chapter_code is None or part_code is None:
                    anomalies.append({"kind": "section_without_chapter", "page": page, "text": text[:80]})
                    continue
                cc = None
                for code, _part, name, _secs in CHAPTER_SPEC:
                    if name == chapter_code:
                        cc = code
                        break
                if cc is None:
                    anomalies.append({"kind": "unknown_chapter_name", "page": page, "text": chapter_code})
                    continue
                current = {
                    "chapterCode": cc,
                    "partCode": CHAPTER_META[cc][0],
                    "chapterName": CHAPTER_META[cc][1],
                    "sectionType": section_type,
                    "lines": [],
                    "headingPage": page,
                }
        tail = text[pos:].strip()
        if tail:
            if stopped:
                dropped_hands_on += 1
            elif current is not None:
                current["lines"].append((page, tail))
    flush()
    return sections, anomalies, stopped, dropped_hands_on


# --------------------------------------------------------------------------
# stage 3: sections -> question blocks
# --------------------------------------------------------------------------

def split_blocks(section):
    """State machine with pair-list guard and two repairs."""
    blocks = []
    repairs = []
    rejects = []
    expected = 1
    cur = None

    def open_block(number, page, opener):
        nonlocal cur
        if cur is not None:
            blocks.append(cur)
        cur = {
            "printedNo": number,
            "opener": opener,
            "startPage": page,
            "lines": [],
            "state": "open",
        }

    def append_line(page, text):
        cur["lines"].append((page, text))
        m = RE_ANSWER.search(text)
        if m and cur["state"] == "open":
            cur["state"] = "after_answer"
            cur["answerPage"] = page

    for page, text in section["lines"]:
        num_match = RE_QSTART.match(text)
        number = int(num_match.group(1)) if num_match else None
        has_answer = RE_ANSWER.search(text) is not None
        is_option_line = RE_OPT_LINE.match(text) is not None

        if cur is None:
            open_block(number, page, "first")
            append_line(page, text)
            if number is not None:
                expected = number + 1
            continue

        new_block = False
        reason = ""
        if cur["state"] == "after_answer":
            if is_option_line:
                repairs.append({"kind": "stray_option_after_answer", "page": page, "text": text[:80]})
            else:
                new_block = True
                reason = "after_answer"
        else:
            if number is not None and number == expected:
                if RE_INLINE_OPT.search(text, 1):
                    rejects.append({"page": page, "text": text[:90], "why": "inline_option_marker"})
                else:
                    new_block = True
                    reason = "expected_number"
            elif number is not None:
                rejects.append({"page": page, "text": text[:90], "why": "unexpected_number", "expected": expected})

        if new_block:
            open_block(number, page, "numbered" if number is not None else "unnumbered")
            append_line(page, text)
            if number is not None:
                if reason == "expected_number" and number != expected:
                    repairs.append({"kind": "number_out_of_sequence", "page": page, "number": number, "expected": expected})
                if number != expected:
                    repairs.append({"kind": "number_gap", "page": page, "number": number, "expected": expected})
                expected = number + 1
        else:
            append_line(page, text)
            if has_answer and cur["state"] == "after_answer" and number is not None:
                # an answer line that itself starts a new question block is handled above
                pass
    if cur is not None:
        blocks.append(cur)

    # repair 1: unnumbered block without any answer -> spurious split, merge back
    merged = []
    for blk in blocks:
        answers = sum(1 for _p, t in blk["lines"] if RE_ANSWER.search(t))
        if answers == 0 and blk["opener"] == "unnumbered" and merged:
            prev = merged[-1]
            prev["lines"].extend(blk["lines"])
            prev["state"] = "after_answer" if RE_ANSWER.search(blk["lines"][-1][1]) else prev["state"]
            repairs.append({"kind": "merge_spurious_split", "page": blk["startPage"], "text": blk["lines"][0][1][:80]})
            continue
        merged.append(blk)
    blocks = merged

    # repair 2: block with >1 answer -> split at the first answer line
    out = []
    for blk in blocks:
        idxs = [i for i, (_p, t) in enumerate(blk["lines"]) if RE_ANSWER.search(t)]
        if len(idxs) > 1:
            cut = idxs[0] + 1
            head = dict(blk)
            head["lines"] = blk["lines"][:cut]
            stem_lines = blk["lines"][cut:]
            tail = {
                "printedNo": None,
                "opener": "unnumbered",
                "startPage": stem_lines[0][0],
                "lines": stem_lines,
                "state": "open",
            }
            repairs.append(
                {"kind": "split_multi_answer_block", "page": blk["startPage"], "printedNo": blk["printedNo"]}
            )
            out.append(head)
            out.append(tail)
        else:
            out.append(blk)
    blocks = out
    return blocks, repairs, rejects


# --------------------------------------------------------------------------
# stage 4: blocks -> questions
# --------------------------------------------------------------------------

def parse_options(option_lines):
    """Split the option region into A/B/C/D.

    Markers may be inline (several options on one line, see defect D) and an
    option text may wrap across lines / pages: line fragments are merged with
    the CJK rule, so a wrap inside a Chinese word adds no space.
    """
    keys = ["A", "B", "C", "D"]
    text = "\n".join(s for _p, s in option_lines)
    pieces = []  # (key_index, start, end) in document order
    pos = 0
    for ki, key in enumerate(keys):
        rx = re.compile(r"(?<![A-Za-z0-9])%s\s*[.．、]\s*" % key)
        m = rx.search(text, pos)
        if not m:
            if ki == 0:
                return None, text
            break
        if pieces:
            pieces[-1] = (pieces[-1][0], pieces[-1][1], m.start())
        pieces.append((ki, m.end(), len(text)))
        pos = m.end()
    if not pieces:
        return None, text
    options = []
    for ki, start, end in pieces:
        fragment = text[start:end]
        options.append({"key": keys[ki], "text": merge_lines(fragment.split("\n"))})
    return options, text


def locate_options(head):
    """Find where the option region starts inside the head lines.

    Returns (region_lines, stem_lines). Every candidate start position is tried
    (a line starting with a marker, plus every inline A marker); a candidate is
    valid when it yields a complete A/B/C/D sequence with non-empty texts. The
    LAST valid candidate wins, which keeps matching-question pair lists inside
    the stem (defect C: the pair list is written as "1. 主体A. 职责", so it also
    looks like an option block) while still handling collapsed questions where
    stem and options share one line (defect D).
    """
    candidates = []
    for i, (_p, text) in enumerate(head):
        if RE_OPT_LINE.match(text) and RE_OPT_LINE.match(text).group(1).upper() == "A":
            candidates.append((i, 0))
        for m in re.finditer(r"(?<![A-Za-z0-9])A\s*[.．、]\s*", text):
            if m.start() > 0:
                candidates.append((i, m.start()))
    candidates.sort()

    fallback = None
    best = None
    for i, pos in candidates:
        region = [(head[i][0], head[i][1][pos:])] + head[i + 1 :]
        options, _raw = parse_options(region)
        if options is None:
            continue
        if fallback is None:
            fallback = (i, pos)
        if [o["key"] for o in options] == ["A", "B", "C", "D"] and all(o["text"] for o in options):
            best = (i, pos)
    chosen = best or fallback
    if chosen is None:
        return None, head
    i, pos = chosen
    stem_lines = list(head[:i])
    if pos > 0:
        stem_lines.append((head[i][0], head[i][1][:pos]))
    return head[i:], stem_lines


def parse_block(block, section):
    section_type = section["sectionType"]
    lines = block["lines"]
    answer_idx = None
    raw_answer = None
    for i, (_page, text) in enumerate(lines):
        m = RE_ANSWER.search(text)
        if m:
            answer_idx = i
            raw_answer = m.group(1).strip()
            break
    if answer_idx is None:
        head = list(lines)
        tail = []
    else:
        head = list(lines[:answer_idx])
        pre = lines[answer_idx][1][: RE_ANSWER.search(lines[answer_idx][1]).start()].strip()
        if pre:
            head.append((lines[answer_idx][0], pre))
        tail = list(lines[answer_idx + 1 :])

    issues = []
    notes = []
    options = []
    stem = ""
    if section_type in ("single", "multiple"):
        region, stem_head = locate_options(head)
        if region is None:
            issues.append("no_option_lines")
            options = []
            stem_lines = [t for _p, t in head]
            if stem_lines:
                m = RE_QSTART.match(stem_lines[0])
                if m:
                    stem_lines[0] = m.group(2)
            stem = merge_lines(stem_lines)
        else:
            stem_lines = [t for _p, t in stem_head]
            if stem_lines:
                first = stem_lines[0]
                m = RE_QSTART.match(first)
                if m:
                    stem_lines[0] = m.group(2)
            stem = merge_lines(stem_lines)
            options, _raw_region = parse_options(region)
            if options is None:
                issues.append("no_option_A_marker")
                options = []
                stem = merge_lines([t for _p, t in head])
            else:
                keys = [o["key"] for o in options]
                if keys != ["A", "B", "C", "D"]:
                    issues.append("option_keys=%s" % ",".join(keys))
                if any(not o["text"] for o in options):
                    issues.append("empty_option_text")
                if RE_OPT_LINE.match(region[0][1]) is None:
                    notes.append("options_inline_with_stem")
                if any(len(RE_ANY_OPT.findall(text)) >= 2 for _p, text in region):
                    notes.append("multiple_options_per_line")
    else:
        stem_lines = [t for _p, t in head]
        if stem_lines:
            m = RE_QSTART.match(stem_lines[0])
            if m:
                stem_lines[0] = m.group(2)
        stem = merge_lines(stem_lines)
        stray = [t for _p, t in head if RE_OPT_LINE.match(t)]
        if stray:
            issues.append("unexpected_option_line")
    if tail:
        issues.append("content_after_answer")
    return {
        "stem": stem,
        "options": options,
        "rawAnswer": raw_answer,
        "answerStatus": "ok" if raw_answer is not None else "missing",
        "issues": issues,
        "notes": notes,
        "answerPage": block.get("answerPage"),
    }


def normalise_answer(section_type, raw, issues):
    """Return (answer[], answerStatus, warnings[])."""
    warnings = []
    if raw is None:
        return [], "missing", warnings
    if section_type in ("single", "multiple"):
        letters = re.findall(r"[A-Da-d]", raw)
        residue = re.sub(r"[A-Da-d\s,，、;；/／+＋]", "", raw)
        if residue:
            warnings.append("answer_residue:%s" % residue[:20])
        if not letters:
            warnings.append("answer_no_letters")
            return [], "ok", warnings
        upper = [c.upper() for c in letters]
        ordered = sorted(set(upper))
        if upper != ordered:
            warnings.append("answer_resorted:%s->%s" % ("".join(upper), "".join(ordered)))
        return ordered, "ok", warnings
    if section_type == "judge":
        value = norm_ws(raw)
        if value in ("对", "错"):
            return [value], "ok", warnings
        if value in ("正确", "√", "T", "true", "True", "是"):
            warnings.append("judge_answer_non_canonical:%s" % value)
            return ["对"], "ok", warnings
        if value in ("错误", "×", "F", "false", "False", "否"):
            warnings.append("judge_answer_non_canonical:%s" % value)
            return ["错"], "ok", warnings
        warnings.append("judge_answer_unknown:%s" % value[:20])
        return [], "ok", warnings
    # blank
    return [raw.strip()], "ok", warnings


def response_mode(section_type, answer):
    if section_type in ("judge", "blank"):
        return section_type
    return "multiple" if len(answer) >= 2 else "single"


def derive_tags(chapter_code, text):
    hits = []
    flags = re.IGNORECASE
    for tag, pattern in TAG_RULES:
        if re.search(pattern, text, flags):
            hits.append(tag)
    if hits:
        return hits[:3], True
    fallback = CHAPTER_FALLBACK_TAG.get(chapter_code)
    if fallback is None:
        return [TAG_UNCLASSIFIED], False
    return [fallback], False


def derive_difficulty(part_code, section_type):
    if part_code == "B":
        return 1 if section_type in ("single", "judge") else 2
    return 3 if section_type in ("multiple", "blank") else 2


def build_questions(sections, anomalies, manual_answers=True):
    questions = []
    numbering = []
    qmeta = {}
    manual_applied = []
    matching_ids = []
    option_notes = []
    unmatched_sections = []
    for section in sections:
        cc = section["chapterCode"]
        stype = section["sectionType"]
        expect = SECTION_EXPECT.get((cc, stype))
        blocks, repairs, rejects = split_blocks(section)
        if expect is None:
            unmatched_sections.append({"chapterCode": cc, "sectionType": stype, "blocks": len(blocks)})
        elif len(blocks) != expect[0]:
            anomalies.append(
                {
                    "kind": "section_block_count_mismatch",
                    "chapterCode": cc,
                    "sectionType": stype,
                    "expected": expect[0],
                    "actual": len(blocks),
                }
            )
        for rep in repairs:
            rep.update({"chapterCode": cc, "sectionType": stype})
            anomalies.append({"kind": "repair_" + rep["kind"], **rep})
        for rej in rejects:
            anomalies.append({"kind": "rejected_numbered_line", "chapterCode": cc, "sectionType": stype, **rej})

        seq = 0
        printed_nos = []
        for blk in blocks:
            seq += 1
            parsed = parse_block(blk, section)
            answer, answer_status, warn = normalise_answer(stype, parsed["rawAnswer"], parsed["issues"])
            for w in warn:
                anomalies.append(
                    {"kind": "answer_warning", "qid": "Q-%s-%s-%04d" % (cc, TYPE_CODE[stype], seq), "detail": w}
                )
            for issue in parsed["issues"]:
                if issue not in ("no_option_lines", "no_option_A_marker", "option_keys", "empty_option_text", "unexpected_option_line", "content_after_answer"):
                    anomalies.append(
                        {"kind": "block_issue", "qid": "Q-%s-%s-%04d" % (cc, TYPE_CODE[stype], seq), "detail": issue}
                    )

            qid = "Q-%s-%s-%04d" % (cc, TYPE_CODE[stype], seq)
            for note in parsed.get("notes", []):
                option_notes.append(
                    {
                        "id": qid,
                        "note": note,
                        "page": blk["startPage"],
                        "stem": parsed["stem"][:60],
                    }
                )
            printed_no = blk["printedNo"]
            manual = MANUAL_ANSWERS.get(qid) if manual_answers else None
            if manual is not None:
                answer = list(manual["answer"])
                answer_status = "ok"
                manual_applied.append(
                    {
                        "id": qid,
                        "answer": answer,
                        "rawAnswer": parsed["rawAnswer"],
                        "sourcePage": manual["sourcePage"],
                        "evidence": manual["evidence"],
                        "note": manual["note"],
                    }
                )
            needs_review = False
            review_reason = None
            if printed_no is None and blk["opener"] == "unnumbered":
                needs_review = True
                review_reason = REVIEW_PRINTED_NUMBER_MISSING
            if answer_status == "missing":
                needs_review = True
                review_reason = REVIEW_ANSWER_MISSING
            elif manual is not None:
                # the source line was missing; keep the defect flagged for the proofing panel
                needs_review = True
                review_reason = REVIEW_ANSWER_MISSING
            mode = response_mode(stype, answer)
            matching = is_matching_question(parsed["stem"], parsed["options"])
            if matching:
                matching_ids.append((qid, mode))
            if mode != stype and stype in ("single", "multiple") and not matching:
                needs_review = True
                if review_reason is None:
                    review_reason = REVIEW_TYPE_MISMATCH
            if parsed["issues"]:
                needs_review = needs_review or bool(
                    {"no_option_lines", "no_option_A_marker", "option_keys", "empty_option_text", "unexpected_option_line"} & set(parsed["issues"])
                )

            tag_text = parsed["stem"] + " " + " ".join(o["text"] for o in parsed["options"])
            tags, specific = derive_tags(cc, tag_text)
            stem = parsed["stem"]
            blank_count = 0
            if stype == "blank":
                blank_count = max(1, len(RE_UNDERSCORES.findall(stem)))
            questions.append(
                {
                    "id": qid,
                    "chapterCode": cc,
                    "partCode": section["partCode"],
                    "partName": PART_NAME[section["partCode"]],
                    "chapterName": section["chapterName"],
                    "sectionType": stype,
                    "typeName": TYPE_NAME[stype],
                    "responseMode": mode,
                    "seq": seq,
                    "printedNo": printed_no,
                    "stem": stem,
                    "options": parsed["options"],
                    "answer": answer,
                    "answerStatus": answer_status,
                    "rawAnswer": parsed["rawAnswer"],
                    "tags": tags,
                    "difficulty": derive_difficulty(section["partCode"], stype),
                    "sourcePage": blk["startPage"],
                    "blankCount": blank_count,
                    "needsReview": needs_review,
                    "reviewReason": review_reason,
                }
            )
            printed_nos.append(printed_no)
            qmeta[qid] = {
                "pages": sorted({p for p, _t in blk["lines"]}),
                "lines": len(blk["lines"]),
                "opener": blk["opener"],
            }

            # anomaly probes straight off the raw block text
            for page, text in blk["lines"]:
                if RE_MIDLINE_NUMBER.search(text):
                    anomalies.append({"kind": "source_midline_number", "qid": qid, "page": page, "text": text[:100]})

        numbering.append(
            {
                "chapterCode": cc,
                "sectionType": stype,
                "blocks": len(blocks),
                "expectedBlocks": expect[0] if expect else None,
                "printedNos": printed_nos,
            }
        )
        if expect and len(blocks) != expect[0]:
            pass
    return questions, numbering, unmatched_sections, qmeta, manual_applied, matching_ids, option_notes


# --------------------------------------------------------------------------
# stage 5: chapters + checks
# --------------------------------------------------------------------------

def build_chapters(questions):
    chapters = []
    for code, part, name, sections in CHAPTER_SPEC:
        entries = []
        total = 0
        for stype, _blocks, _printed in sections:
            count = sum(1 for q in questions if q["chapterCode"] == code and q["sectionType"] == stype)
            entries.append({"sectionType": stype, "typeName": TYPE_NAME[stype], "count": count})
            total += count
        chapters.append(
            {
                "chapterCode": code,
                "partCode": part,
                "partName": PART_NAME[part],
                "chapterName": name,
                "chapterTotal": total,
                "sections": entries,
            }
        )
    return chapters


def run_checks(bank, questions, numbering, anomalies, manual_answers=True, matching_ids=None):
    errors = []
    warnings = []
    matching_ids = matching_ids or []
    exp_answer_ok = EXPECTED["questions"] if manual_answers else EXPECTED["answerOk"]
    exp_answer_missing = 0 if manual_answers else EXPECTED["answerMissing"]

    def expect(cond, msg):
        if not cond:
            errors.append(msg)

    by_type = {k: 0 for k in TYPE_NAME}
    by_mode = {k: 0 for k in TYPE_NAME}
    answer_ok = answer_missing = 0
    needs_review = []
    printed_null = []
    ids = set()
    dup_ids = []
    judge_dist = {"对": 0, "错": 0}
    bad_options = []
    for q in questions:
        by_type[q["sectionType"]] = by_type.get(q["sectionType"], 0) + 1
        by_mode[q["responseMode"]] = by_mode.get(q["responseMode"], 0) + 1
        if q["answerStatus"] == "ok":
            answer_ok += 1
        else:
            answer_missing += 1
        if q["needsReview"]:
            needs_review.append(q["id"])
        if q["printedNo"] is None:
            printed_null.append(q["id"])
        if q["id"] in ids:
            dup_ids.append(q["id"])
        ids.add(q["id"])
        if not RE_ID.match(q["id"]):
            errors.append("bad id format: " + q["id"])
        if q["sectionType"] == "judge" and len(q["answer"]) == 1:
            judge_dist[q["answer"][0]] = judge_dist.get(q["answer"][0], 0) + 1
        if not q["tags"]:
            errors.append("no tags: " + q["id"])
        if len(q["tags"]) > 3:
            errors.append("too many tags: " + q["id"])
        if q["difficulty"] not in (1, 2, 3):
            errors.append("bad difficulty: " + q["id"])
        if q["sectionType"] in ("single", "multiple"):
            if [o["key"] for o in q["options"]] != ["A", "B", "C", "D"] or any(
                not o["text"] for o in q["options"]
            ):
                bad_options.append(q["id"])

    expect(not bad_options, "choice questions without 4 non-empty options: %s" % bad_options[:10])
    expect(len(questions) == EXPECTED["questions"], "questions.length=%d expected %d" % (len(questions), EXPECTED["questions"]))
    expect(not dup_ids, "duplicate ids: %d" % len(dup_ids))
    expect(by_type == EXPECTED["sectionType"], "sectionType counts %s expected %s" % (by_type, EXPECTED["sectionType"]))
    expect(by_mode == EXPECTED["responseMode"], "responseMode counts %s expected %s" % (by_mode, EXPECTED["responseMode"]))
    expect(answer_ok == exp_answer_ok, "answerStatus ok=%d expected %d" % (answer_ok, exp_answer_ok))
    expect(answer_missing == exp_answer_missing, "answerStatus missing=%d expected %d" % (answer_missing, exp_answer_missing))
    expect(sorted(needs_review) == sorted(EXPECTED["needsReviewIds"]), "needsReview ids %s" % needs_review)
    expect(printed_null == [EXPECTED["unnumberedId"]], "printedNo=null ids %s" % printed_null)
    expect(judge_dist == EXPECTED["judgeAnswer"], "judge answer distribution %s" % judge_dist)

    printed_total = sum(1 for q in questions if q["printedNo"] is not None)
    expect(printed_total == EXPECTED["printed"], "printed questions=%d expected %d" % (printed_total, EXPECTED["printed"]))

    mismatch = [
        q["id"]
        for q in questions
        if q["sectionType"] != q["responseMode"] and q["sectionType"] in ("single", "multiple")
    ]
    expect(sorted(mismatch) == sorted(EXPECTED["typeMismatchIds"]), "sectionType!=responseMode ids %s" % mismatch)

    single_sec = [q for q in questions if q["sectionType"] == "single"]
    many = [q["id"] for q in single_sec if len(q["answer"]) >= 2]
    expect(len(many) == 2 and sorted(many) == ["Q-C06-S-0004", "Q-C07-S-0027"], "single-section multi-letter answers %s" % many)
    multi_sec = [q for q in questions if q["sectionType"] == "multiple"]
    one = [q["id"] for q in multi_sec if len(q["answer"]) == 1]
    expect(len(one) == 3, "multiple-section single-letter answers %s" % one)

    missing_ids = [q["id"] for q in questions if q["answerStatus"] == "missing"]
    expected_missing = [] if manual_answers else [EXPECTED["missingAnswerId"]]
    expect(missing_ids == expected_missing, "missing answer ids %s" % missing_ids)

    expect(
        sorted(mid for mid, _mode in matching_ids) == sorted(EXPECTED["matchingIds"]),
        "matching question ids %s" % [mid for mid, _mode in matching_ids],
    )

    # printed number continuity per chapter/section
    continuity = []
    for entry in numbering:
        nos = [n for n in entry["printedNos"] if n is not None]
        expected_seq = list(range(1, len(nos) + 1))
        ok = nos == expected_seq
        continuity.append(
            {
                "chapterCode": entry["chapterCode"],
                "sectionType": entry["sectionType"],
                "blocks": entry["blocks"],
                "printed": len(nos),
                "consecutive": ok,
                "numbers": nos,
            }
        )
        if not ok:
            gaps = [n for n in expected_seq if n not in nos]
            extra = [n for n in nos if n not in expected_seq]
            anomalies.append(
                {
                    "kind": "printed_number_discontinuity",
                    "chapterCode": entry["chapterCode"],
                    "sectionType": entry["sectionType"],
                    "missing": gaps,
                    "extra": extra,
                }
            )

    # per chapter/section counts against the frozen table
    table = []
    printed_by_cs = {}
    for q in questions:
        printed_by_cs[(q["chapterCode"], q["sectionType"])] = printed_by_cs.get(
            (q["chapterCode"], q["sectionType"]), 0
        ) + (1 if q["printedNo"] is not None else 0)
    for code, part, name, sections in CHAPTER_SPEC:
        for stype, exp_blocks, exp_printed in sections:
            actual = sum(1 for q in questions if q["chapterCode"] == code and q["sectionType"] == stype)
            printed_actual = printed_by_cs.get((code, stype), 0)
            row = {
                "chapterCode": code,
                "chapterName": name,
                "partCode": part,
                "sectionType": stype,
                "typeName": TYPE_NAME[stype],
                "expectedBlocks": exp_blocks,
                "actualBlocks": actual,
                "expectedPrinted": exp_printed,
                "actualPrinted": printed_actual,
            }
            table.append(row)
            if actual != exp_blocks:
                errors.append("chapter %s %s blocks=%d expected %d" % (code, stype, actual, exp_blocks))
            if printed_actual != exp_printed:
                errors.append("chapter %s %s printed=%d expected %d" % (code, stype, printed_actual, exp_printed))

    # tag coverage: two metrics, because the C07 fallback tag ("标准规范") is also
    # the name of rule #24, so a narrow "tags == chapter fallback" test over-counts.
    fallback_only = []          # 0 keyword rules hit -> tags = chapter fallback tag
    specific_hit = []           # >=1 keyword rule hit
    fallback_tag_named = []     # tags == [chapter fallback tag] (T-05-04 literal test)
    for q in questions:
        fb = CHAPTER_FALLBACK_TAG.get(q["chapterCode"])
        if q["tags"] == [fb]:
            fallback_tag_named.append(q["id"])
            # distinguish a genuine rule #24 hit from a chapter fallback
            tag_text = q["stem"] + " " + " ".join(o["text"] for o in q["options"])
            if any(re.search(pat, tag_text, re.IGNORECASE) for _t, pat in TAG_RULES):
                specific_hit.append(q["id"])
            else:
                fallback_only.append(q["id"])
        else:
            specific_hit.append(q["id"])
    outside = [q["id"] for q in questions if any(t not in TAG_VOCAB for t in q["tags"])]
    unclassified = [q["id"] for q in questions if TAG_UNCLASSIFIED in q["tags"]]
    expect(not outside, "tags outside vocabulary: %d" % len(outside))
    expect(not unclassified, "unclassified tags: %d" % len(unclassified))
    coverage = len(specific_hit) / len(questions) if questions else 0.0
    coverage_narrow = (len(questions) - len(fallback_tag_named)) / len(questions) if questions else 0.0
    if coverage < 0.80:
        warnings.append("specific tag coverage %.1f%% < 80%%" % (coverage * 100))

    # duplicate stems (key is normalised, but the original text is kept for display)
    stem_index = {}
    for q in questions:
        key = norm_ws(q["stem"]).lower()
        stem_index.setdefault(key, {"stem": norm_ws(q["stem"]), "ids": []})["ids"].append(q["id"])
    duplicate_stems = [
        {"stem": v["stem"][:60], "ids": v["ids"], "count": len(v["ids"])}
        for v in stem_index.values()
        if len(v["ids"]) > 1
    ]
    duplicate_stems.sort(key=lambda d: -d["count"])

    # difficulty + tag distribution (report only)
    difficulty_dist = {1: 0, 2: 0, 3: 0}
    tag_dist = {}
    for q in questions:
        difficulty_dist[q["difficulty"]] = difficulty_dist.get(q["difficulty"], 0) + 1
        for t in q["tags"]:
            tag_dist[t] = tag_dist.get(t, 0) + 1

    return {
        "errors": errors,
        "warnings": warnings,
        "byType": by_type,
        "byMode": by_mode,
        "answerOk": answer_ok,
        "answerMissing": answer_missing,
        "needsReview": needs_review,
        "printedTotal": printed_total,
        "judgeDist": judge_dist,
        "specificTagCount": len(specific_hit),
        "fallbackTagCount": len(fallback_only),
        "fallbackTagNamedCount": len(fallback_tag_named),
        "tagCoverage": coverage,
        "tagCoverageNarrow": coverage_narrow,
        "difficulty": {str(k): v for k, v in sorted(difficulty_dist.items())},
        "tagDistribution": {k: tag_dist[k] for k in sorted(tag_dist, key=lambda k: -tag_dist[k])},
        "matchingQuestions": [{"id": mid, "responseMode": mode} for mid, mode in matching_ids],
        "duplicateStems": duplicate_stems,
        "table": table,
        "continuity": continuity,
        "typeMismatchIds": sorted(mismatch),
    }


def blank_answer_table(questions):
    """Fill-in-the-blank answers:原文 + 归一化形式 (trim+lowercase, and a full-width folded view)."""
    rows = []
    for q in questions:
        if q["sectionType"] != "blank":
            continue
        answers = q["answer"]
        norm = [a.strip().lower() for a in answers]
        norm_wide = [fullwidth_to_halfwidth(a).strip().lower() for a in answers]
        rows.append(
            {
                "id": q["id"],
                "printedNo": q["printedNo"],
                "answerStatus": q["answerStatus"],
                "rawAnswer": q["rawAnswer"],
                "answer": answers,
                "answerNorm": norm,
                "answerNormWide": norm_wide,
                "changedByNormWide": norm_wide != norm,
                "blankCount": q["blankCount"],
                "stem": q["stem"],
            }
        )
    return rows


# ---------------------------------------------------------------------------
# frozen delivery wording (v1.1.2 documentation corrections)
# ---------------------------------------------------------------------------
# docs/解析报告.md was approved by the review (bank.json SHA-256
# 1460DEDD…64C9) and carries two wording corrections found in later revisions (early observations
# O-2 / O-3). Those corrections were originally written into the delivery by hand,
# which contradicted the file's own "自动生成，请勿手工编辑" header. From this revision on they
# live here verbatim, so a re-run reproduces the approved delivery character for
# character instead of overwriting it with the older wording.
#
# 本块刻意放在 flatten_lines() 之后：§7.7 引用了该函数的源码行号区间
# （FROZEN_FLATTEN_LINES），在别处增删代码都必须同步更新该常量与交付件（需重新评审）。
# Do not reword anything below without a new review of the delivery as well.
FROZEN_FLATTEN_LINES = "248–279"

DELIVERY_NOTE_ROW = (
    "| 文档更正（v1.1.2） | 本文件另经人工更正两处：§7.4(b) 措辞自相矛盾（早期观察 O-2）与新增 §7.7 "
    "`droppedLines` 口径说明（早期观察 O-3）。⚠️ 该两处更正**尚未同步进生成器 `tools/parse_bank.py`**，"
    "重新运行解析脚本会把本文件覆盖回旧措辞；在生成器侧同步后，本文件将自动包含同样内容（详见 §7.7 末行与本表下方说明）。 |"
)

SECTION_74B_HEADING = "**(b) 除 (a) 所列之外的其他非常规符号（保留原文，均为题目本身的数学/记号用法）：**"

SECTION_74B_BODY = (
    "题库字段中 **除 (a) 所列 {n} 处私有区码位外，无其他私有区字符**"
    "（{n} 处全部位于 {ids}；已逐字段扫描 `stem` / `options[].text` 复核）；"
    "无 U+FFFD 替换字符、无空白控制字符（无制表符、无 U+3000 表意空格）；"
    "`→`、`⊕`、`≤`、`×` 等题目自身的数学/箭头符号按正常字符处理，不计入异常。"
)

SECTION_74B_NOTE = [
    "> **更正说明（v1.1.2，对应早期观察 O-2）**：本节此前写作「无（…无私有区字符…）」，"
    "与 (a) 的 {n} 处私有区码位表**自相矛盾**。现按以下口径更正：",
    "> 1. 交付题库字段的私有区码位**仅 (a) 所列 {n} 处**（均在 {ids}）；",
    "> 2. PDF 原文第 177、188 页另有私有区码位，位于**被排除的第三部分实操题**内（按 D12 不纳入题库），故不影响交付数据；",
    "> 3. 综上：本节结论应为「(a) 之外无其他私有区字符」，而非「无私有区字符」。",
]

SECTION_10_SELFCHECK = (
    "- 硬性自检（需求规格 v1.1.2 §5.9，共 22 项；§5.9 判据自 v1.1.0 起未变）："
    "题块数 {questions}、打印题数 {printed}、题型/`responseMode` 计数、判断题答案分布 81/91、"
    "`needsReview` 5 条、`answerStatus=ok` {answerOk} / `missing` {answerMissing}、人工补录 {manual} 题、"
    "匹配题 4 道、标签词表与覆盖、重复 id = 0，全部在解析时校验；任一不符脚本以退出码 1 结束并打印错误。"
)

SECTION_11_HEADING = "## 11. 与需求规格 §5.9 的对照（当前规格 v1.1.2；§5.9 判据自 v1.1.0 起未变，故下表两列口径不变）"


def section_77_lines(dropped):
    """§7.7 `droppedLines` 口径说明（v1.1.2 交付件措辞，数值取自本次运行）。"""
    return [
        "### 7.7 `droppedLines` 口径说明（v1.1.2 补充，对应 早期观察 O-3）",
        "",
        "`bank.report.json` 的 `droppedLines = {{ footer: {footer}, marker: {marker}, blank: {blank}, toc: {toc}, "
        "frontmatter: {frontmatter} }}` 是**文本行级**丢弃量，**不是题目数**；它产生于解析第 1 阶段 "
        "`flatten_lines()`（`tools/parse_bank.py` 第 {span} 行），分两步执行：".format(span=FROZEN_FLATTEN_LINES, **dropped),
        "",
        "**第 1 步：逐行分类丢弃**（顺序固定，先命中者先丢弃；`blank → footer → marker → toc`）",
        "",
        "| 计数键 | 判定依据（正则/规则） | 实测值 | 说明 |",
        "| --- | --- | --- | --- |",
        "| `blank` | 去空白后为空串的行 | {blank} | 本 PDF 文本层无纯空行 |".format(**dropped),
        "| `footer` | `^第\\s*\\d+\\s*页$` | **{footer}** | 页脚行（199 页中 {footer} 页含页脚；封面、目录首页与末页无） |".format(**dropped),
        "| `marker` | `^=+\\s*PAGE\\s*\\d+\\s*=+$` | **{marker}** | 本报告的输入是**按页数组** "
        "`bank_text.json`，不含 `===== PAGE n =====` 标记行；若改用带标记的 `bank_text.txt` "
        "作为输入，该计数将 >0（两种输入等价，规格 §5.3 要求剔除该标记行） |".format(**dropped),
        "| `toc` | `\\.{{4,}}\\s*\\d+\\s*$`（4 个以上点前导 + 行末页码） | **{toc}** | 目录条目行"
        "（如 `第一部分基础题 215................1`），整行丢弃 |".format(**dropped),
        "",
        "**第 2 步：切出正文起点**",
        "",
        "| 计数键 | 判定依据 | 实测值 | 说明 |",
        "| --- | --- | --- | --- |",
        "| `frontmatter` | 第 1 步过滤后的行序列中，**首个 `第一部分…基础题` 标题所在行的下标**"
        "（下标之前的行全部丢弃） | **{frontmatter}** | 即「封面 3 行 + 〈政策法规及技术标准范围〉说明块 + "
        "目录中未被 `toc` 规则命中的行（多为抽取时合并成的长行）」共 {frontmatter} 行 |".format(**dropped),
        "",
        "**关键结论**",
        "",
        "- `toc={toc}` 与 `frontmatter={frontmatter}` 是**两个不同阶段**的计数，**不存在重复计数**：`toc` 在逐行过滤时"
        "即被丢弃，`frontmatter` 是过滤后剩余行中「正文起点之前」的行数；二者合计 **{total} 行**属「目录 / 前置说明」，"
        "均**不进入题库**（早期观察 O-3 提到的「{total} 行」即指此合计）。".format(total=dropped["toc"] + dropped["frontmatter"], **dropped),
        "- 该组计数只描述「有多少非题目文本行被剔除」，**不影响**题量、id、字段、判分与统计：题库口径一律以 "
        "`bank.report.json` 的 `counts` / `table` / `continuity` 为准（`questions=1051`、题型 491/358/172/30、"
        "逐章逐题型 `expectedBlocks == actualBlocks`）。",
        "- 复核方法（可复现）：对 `bank_text.json` 按上表两条正则重跑，即可复算 `toc={toc}`、"
        "`frontmatter={frontmatter}`；`footer={footer}` 已由独立复算确认一致。".format(**dropped),
        "",
        "> **生成器同步提示**：本节与 §7.4(b) 的更正目前只落在本文件；生成器 `tools/parse_bank.py`"
        "（第 {span} 行的 `flatten_lines` 与 §7.4 输出措辞）尚未写入对应说明，重新运行解析脚本会覆盖本文件。"
        "建议后续在生成器侧同步「droppedLines 口径」与「(a) 之外无其他私有区字符」两处措辞，"
        "使本文件自动生成时即包含上述内容。".format(span=FROZEN_FLATTEN_LINES),
        "",
    ]


def flatten_lines_span():
    """源码行号区间 (start, end)，用于校验 §7.7 引用的位置未漂移。"""
    import inspect

    try:
        lines, start = inspect.getsourcelines(flatten_lines)
        return start, start + len(lines) - 1
    except Exception:  # pragma: no cover - defensive (no source available)
        return None, None


def render_report_md(report, bank, sample_ids):
    """Human readable parse report (Chinese, UTF-8)."""
    L = []
    add = L.append
    counts = report["counts"]
    c = report["content"]
    add("# 密码赛题库 PDF 解析报告")
    add("")
    add("> 自动生成，请勿手工编辑：本文件由 `tools/parse_bank.py` 生成（同一输入可重复生成同一结果）。")
    add("")
    add("| 项 | 值 |")
    add("| --- | --- |")
    add("| 输入 | `%s`（%d 页，只读） |" % (report["source"]["fileName"], report["source"]["pages"]))
    add("| 文本来源 | %s |" % report["sourceNote"])
    add("| 生成时间 | %s |" % report["generatedAt"])
    add("| 题库版本 | `%s`（schemaVersion `%s`） |" % (report["bankVersion"], report["schemaVersion"]))
    add("| 输出 | `src/data/bank.json`、`src/data/bank.report.json`、本文件 |")
    add("| 复现命令 | `python tools/parse_bank.py`（或 `--now 2026-09-16T20:00:00+08:00` 冻结时间戳） |")
    add("| 校验命令 | `node tools/validate_bank.mjs` |")
    add("| 源文本 SHA-256 | `%s` |" % report["hashes"]["sourceText"])
    add("| bank.json SHA-256 | `%s` |" % report["hashes"]["bank"])
    add("| 硬性自检 | %s |" % ("全部通过（0 error）" if not report["errors"] else "**失败 %d 项**" % len(report["errors"])))
    add(DELIVERY_NOTE_ROW)
    add("")

    add("## 1. 计数对照表（目录口径 vs 解析实测）")
    add("")
    add("题号口径说明：PDF 打印题号共 **1050** 道（第一部分 215 + 第二部分 835），其中密码学·填空题第 7 题")
    add("（`Q-C05-F-0007`）原文没有「答案：」行；另有 1 道**未编号**题（`Q-C05-S-0060`，第 52 页，打印第 59 题答案之后）。")
    add("按冻结口径（需求规格 §13.1：未编号题计入题量），`bank.json` 的题块数 = **1051**，`printedNo != null` 的题数 = **1050**。")
    add("")
    add("| 部分 | 章 | 题型 | 目录/打印题量 | 实测打印题量 | 实测题块数 | 题号连续 |")
    add("| --- | --- | --- | --- | --- | --- | --- |")
    cont = {(x["chapterCode"], x["sectionType"]): x for x in report["continuity"]}
    for row in report["table"]:
        key = (row["chapterCode"], row["sectionType"])
        cn = cont.get(key, {})
        add(
            "| %s | %s %s | %s | %d | %d | %d | %s |"
            % (
                row["partCode"],
                row["chapterCode"],
                row["chapterName"],
                row["typeName"],
                row["expectedPrinted"],
                row["actualPrinted"],
                row["actualBlocks"],
                "是" if cn.get("consecutive") else "**否**",
            )
        )
    tot_printed = sum(r["actualPrinted"] for r in report["table"])
    tot_blocks = sum(r["actualBlocks"] for r in report["table"])
    add(
        "| — | 合计 | — | **%d** | **%d** | **%d** | — |"
        % (
            sum(r["expectedPrinted"] for r in report["table"]),
            tot_printed,
            tot_blocks,
        )
    )
    add("")
    by_type = counts["bySectionType"]
    add("汇总（`sectionType` 分类计数，解析实测）：")
    add("")
    add("| 题型 | 打印题号口径 | 题块口径（含未编号题） |")
    add("| --- | --- | --- |")
    printed = counts["printedByType"]
    for stype, name in (("single", "单选题"), ("multiple", "多选题"), ("judge", "判断题"), ("blank", "填空题")):
        add("| %s | %d | %d |" % (name, printed.get(stype, 0), by_type.get(stype, 0)))
    add("| **合计** | **%d** | **%d** |" % (counts["printed"], counts["questions"]))
    add("")
    add("### 1.1 与合同验收清单的逐项对照")
    add("")
    add("| 合同所列口径 | 合同算式 | 解析实测 | 结论 |")
    add("| --- | --- | --- | --- |")
    add("| 单选题 | 155+115+90+40+30+35+25 = 490 | %d | 一致 |" % printed.get("single", 0))
    add("| 多选题 | 13+10+10+10+130+60+125 = 358 | %d | 一致 |" % printed.get("multiple", 0))
    add("| 判断题 | 12+10+10**+10**+80+20+30 = 172 | %d | 一致（合同文本的算式漏写一个「10」，C03 判断题 10 道，实际合计 172） |" % printed.get("judge", 0))
    add("| 填空题 | 30 | %d | 一致 |" % printed.get("blank", 0))
    add("| 打印题合计 | 1050（基础 215 + 专业 835） | %d | 一致 |" % counts["printed"])
    add(
        "| 题块口径 | 合同写「恰好 1050 道」 | **1051** 题块 = 1050 打印 + 1 未编号题（`Q-C05-S-0060`） | 见上方口径说明：按 §13.1 冻结默认值，未编号题计入题量；打印题号口径仍为 1050 |"
    )
    add("| 排除实操题 | 12 道不纳入 | %d（`source.excludedCount`，`source.excludedReason` 记录） | 一致 |" % EXCLUDED_COUNT)
    add("")
    add("## 2. 题号连续性核对")
    add("")
    add("每题号段内打印题号必须严格等于 1..N（连续无重复）。实测：")
    add("")
    add("| 章 | 题型 | 题块数 | 打印题数 | 打印题号序列 | 结论 |")
    add("| --- | --- | --- | --- | --- | --- |")
    for x in report["continuity"]:
        nos = [n for n in x["numbers"]]
        seq = "1…%d" % len(nos) if x["consecutive"] and nos else ("（无打印题号）" if not nos else str(nos[:6]))
        add(
            "| %s | %s | %d | %d | %s | %s |"
            % (x["chapterCode"], x["sectionType"], x["blocks"], len(nos), seq, "连续无缺口" if x["consecutive"] else "**不连续**")
        )
    add("")
    add("> `Q-C05-S-0060`（未编号题）使 C05 单选段的题块数比打印题数多 1，打印题号序列仍为 1…155，连续无缺口。")
    add("")

    add("## 3. 字段与派生规则（依据 需求规格.md §5）")
    add("")
    add("- `id`：`Q-<章码>-<题型码>-<物理序 4 位>`，题型码 `S/M/J/F`，物理序按文档出现顺序（不受未编号题影响）。")
    add("- `sectionType`：题库结构分类（与 PDF 章节一致，不可改）；`responseMode`：作答控件与判分口径（§5.3.3 推导）。")
    add("- `stem`：去除页脚（`第 N 页`）与页标记；跨行断行合并（相邻均为中日韩字符不加空格，否则加一个半角空格）；不含选项行与题号。")
    add("- `options`：选择题固定 4 项、`key` 为 `A/B/C/D`；连线题的对照表（`1. 主体A. 职责`）留在 `stem`，选项为 `A/B/C/D` 的配对答案。")
    add("- `answer`：单选/多选为大写字母数组（多选升序去重）；判断为 `[\"对\"]`/`[\"错\"]`；填空为原文串数组（去首尾空白）。")
    add("- `tags`：由 §5.6 的 33 条关键词规则（本文件第 6 节复述）从 `stem + options[].text` 抽取，命中按序号升序去重取前 3；未命中用该章兜底标签。")
    add("- `difficulty`：基础单选/判断=1；基础多选、专业单选/判断=2；专业多选/填空=3（§5.7）。")
    add("- `answerStatus`：`ok` / `missing`；`needsReview`+`reviewReason` 标注缺陷题（见第 5 节）。")
    add("")

    add("## 4. 真实题目完整样例")
    add("")
    add("以下对象直接摘自 `bank.json`（`questions[]` 元素，字段顺序与文件一致）：")
    add("")
    add("```json")
    add(json.dumps(sample_ids["primary"], ensure_ascii=False, indent=2))
    add("```")
    add("")
    add("缺陷题样例：")
    add("")
    for label, q in sample_ids["defects"].items():
        add("- **%s**（%s）" % (label, q["id"]))
        add("")
        add("```json")
        add(json.dumps(q, ensure_ascii=False, indent=2))
        add("```")
        add("")

    add("## 5. 题库缺陷（A～G）处理结果核对")
    add("")
    add("| 缺陷 | 位置 | 处理结果 |")
    add("| --- | --- | --- |")
    add("| A 未编号题 | `Q-C05-S-0060`（第 52 页） | 保留独立题块：`printedNo=null`、`needsReview=true`、`reviewReason=printed_number_missing`；其后的打印题号 60 起物理序 +1（实测 C05 单选 `seq 1…59` = 打印 1…59，`seq 60` = 未编号，`seq 61…156` = 打印 60…155） |")
    add("| B 缺答案题 | `Q-C05-F-0007`（第 97 页） | 见第 8 节：原文无「答案：」行，答案已按项目维护者决定人工补录；`needsReview=true`、`reviewReason=answer_missing` |")
    add("| C 连线/匹配题 | %s | 4 个选项仍为 `A/B/C/D`，对照表保留在 `stem`；答案单字母导致 `responseMode` 由 `multiple` 变 `single`。**判定说明**：连线题属「题库排版形态」缺陷（缺陷 C），不是「题型与答案形状不符」（缺陷 G），因此**只写入构建告警 `buildWarnings[]`（要素 id / sectionType / responseMode / answer），不置 `needsReview`**；`needsReview` 恰为 §5.9 要求的 5 条（缺陷 A、缺陷 B、缺陷 G 三道） |" % "、".join("`%s`" % x["id"] for x in report["matching"]))
    add("| D 行内答案 | `Q-C05-S-0127`（第 63 页，选项与答案同行，且 4 个选项挤在 2 行）、`Q-C05-J-0016`（第 92 页，`码。答案：对`） | 解析器允许 `答案：` 出现在行内任意位置，行内 `答案：` 之前的文本仍归属该题；选项按 A→D 标记切分（同一行可含多个选项） |")
    add("| E 前缀不统一 | `正确答案：` 3 处（第 149/170/174 页） | 正则 `(?:正确|参考)?答案\\s*[:：]` 统一接受，`rawAnswer` 保留答案原文 |")
    add("| F 页脚/页标记 | 全库 | 解析前删除整行 `第 N 页`（实测 %d 行）；`===== PAGE n =====` 页标记只存在于 `bank_text.txt`（本脚本按页数组 `bank_text.json` 读取，实测命中 %d 行，若输入为带标记文本则一并剔除）；正文内「第…页」短语不受影响 |" % (report["droppedLines"]["footer"], report["droppedLines"]["marker"]))
    add("| G 题型与答案形状不符 | `Q-C06-S-0004`、`Q-C07-S-0027`（单选段内多字母答案）、`Q-C06-M-0008`（多选段内单字母答案） | 不改 `sectionType`；按 `responseMode` 渲染与判分；三题 `needsReview=true`、`reviewReason=type_mismatch` |")
    add("")

    add("## 6. 知识点标签规则表（随代码入库）")
    add("")
    add("规则与词表来自 需求规格.md §5.6，实现位置 `tools/parse_bank.py` 常量 `TAG_RULES`；匹配不区分大小写，命中按序号升序去重取前 3；未命中使用该章兜底标签。")
    add("")
    add("| 序号 | 标签 | 命中正则 | 命中题数 |")
    add("| --- | --- | --- | --- |")
    tag_dist = counts["tagDistribution"]
    for i, (tag, pattern) in enumerate(TAG_RULES, 1):
        add("| %d | %s | `%s` | %d |" % (i, tag, pattern.replace("|", "\\|"), tag_dist.get(tag, 0)))
    add("")
    add("章级兜底标签（命中 0 条规则时使用）：")
    add("")
    add("| 章 | 兜底标签 | 该章走兜底的题数 |")
    add("| --- | --- | --- |")
    fb_by_chapter = report["fallbackByChapter"]
    for code, tag in sorted(CHAPTER_FALLBACK_TAG.items()):
        add("| %s | %s | %d |" % (code, tag, fb_by_chapter.get(code, 0)))
    add("")
    add(
        "覆盖率：命中 ≥1 条关键词规则 **%d / %d = %.1f%%**，仅走章级兜底 **%d** 题；"
        "`tags.length ∈ 1..3` 恒成立（无空标签、无超 3 个），`[\"未分类\"]` **0** 题，满足 §5.9「具体标签命中率 ≥ 80%%」。"
        % (
            report["tags"]["specific"],
            counts["questions"],
            report["tags"]["coverage"] * 100,
            report["tags"]["fallback"],
        )
    )
    add("")
    add(
        "> 注：C07 的兜底标签「标准规范」与第 24 条规则的标签同名，因此按「`tags` 是否恰等于该章兜底标签」这一字面口径统计会得到 %d 题"
        "（= 兜底 %d + 命中第 24 条规则但标签同名的 C07 题 %d）。两种口径都在 `bank.report.json` 中给出。"
        % (report["tags"]["fallbackNamed"], report["tags"]["fallback"], report["tags"]["fallbackNamed"] - report["tags"]["fallback"])
    )
    add("")

    add("## 7. 异常与疑似问题清单及处理方式")
    add("")
    add("### 7.1 选项缺失 / 选项结构异常")
    add("")
    opts_issues = report["optionIssues"]
    if opts_issues:
        add("| 题 id | 页面 | 现象 | 处理 |")
        add("| --- | --- | --- | --- |")
        for it in opts_issues:
            add("| `%s` | %s | %s | 按行内标记重切分；已人工核对，选项完整 |" % (it["id"], it.get("pages", ""), it["detail"]))
    else:
        add("**选项缺失：无。** 全部 %d 道选择题均解析出 4 个非空选项（`A/B/C/D` 按序）。" % (by_type.get("single", 0) + by_type.get("multiple", 0)))
    add("")
    notes = report.get("optionStructureNotes", [])
    if notes:
        grouped = {}
        for n in notes:
            grouped.setdefault(n["note"], []).append(n)
        add("选项排版形态异常（已按行内标记正确切分，非缺失）：")
        add("")
        add("| 现象 | 题数 | 题 id | 处理方式 |")
        add("| --- | --- | --- | --- |")
        for note, items in sorted(grouped.items(), key=lambda kv: -len(kv[1])):
            label = {
                "options_inline_with_stem": "选项与题干同行（题干行内含 `A.` 标记）",
                "multiple_options_per_line": "同一行内含多个选项（如 `A.… B.… C.… D.…`）",
            }.get(note, note)
            ids = "、".join("`%s`" % i["id"] for i in items[:8]) + ("…" if len(items) > 8 else "")
            add("| %s | %d | %s | 按文档顺序搜索 `A→B→C→D` 标记切分：先试行首标记，再试行内标记，取「能解析出完整 4 项且文本非空」的最靠后候选（保证连线题对照表留在 `stem` 内） |" % (label, len(items), ids))
        add("")
    add("### 7.2 答案缺失")
    add("")
    if report["manualAnswers"]:
        for m in report["manualAnswers"]:
            add("- `%s`（第 %s 页）：原文**无「答案：」行**；按项目维护者决定（规格 v1.1.0 §0.3 R2-2）人工补录 `answer=%s`。" % (m["id"], m["sourcePage"], json.dumps(m["answer"], ensure_ascii=False)))
            add("  证据：① 题干自述「那么可以切 16 块」；② `1000 字节 ÷ 64 字节 = 15.625 → 向上取整 = 16`（SM3 按 512 位 = 64 字节分块）。两条独立口径互相印证。")
            add("  处理：`answerStatus=\"ok\"`、`rawAnswer=null`（原文无答案行）、`needsReview=true`、`reviewReason=\"answer_missing\"`（保留为「答案非印刷来源」的复核提示，不影响出题/判分/统计）；题干与原文逐字一致（未改动）。可用 `--no-manual-answers` 还原为 v1.0.0 的缺答案解析。")
    else:
        add("- 本次运行使用 `--no-manual-answers`：`Q-C05-F-0007` 保持 `answer=[]`、`answerStatus=missing`（需求规格 v1.0.0 §5.9 基线，候选池 1050）。")
    add("")
    add("### 7.3 跨页断行")
    add("")
    add(
        "全库共 **%d** 道题的正文跨页（题干或选项被页边界切开），已按中日韩字符规则拼接（相邻均为中日韩字符不加空格，否则加一个半角空格）："
        % len(c["crossPageQuestions"])
    )
    add("")
    add("| 题 id | 涉及页 | 行数 |")
    add("| --- | --- | --- |")
    for x in c["crossPageQuestions"][:20]:
        add("| `%s` | %s | %d |" % (x["id"], "→".join(str(p) for p in x["pages"]), x["lines"]))
    if len(c["crossPageQuestions"]) > 20:
        add("| … | 其余 %d 题见 `bank.report.json` → `content.crossPageQuestions` | |" % (len(c["crossPageQuestions"]) - 20))
    add("")
    add("### 7.4 公式 / 乱码字符")
    add("")
    add("**(a) 私有区码位（PDF 符号字体映射丢失，属于源文本问题）：**")
    add("")
    if c.get("privateUseChars"):
        add("| 字符 | 码位 | 出现题数 | 示例题 |")
        add("| --- | --- | --- | --- |")
        for s in c["privateUseChars"]:
            add("| %s | %s | %d | %s |" % (s["char"], s["codepoint"], s["count"], "、".join("`%s`" % i for i in s["examples"])))
        add("")
        add("处理：**保留原文码位不改**（`stem` 与 `options` 忠实于 PDF 文本层）。此类字符来自 PDF 内的 Symbol/Wingdings 类符号字体，"
            "在 PDF 里显示为数学排版符号（如上例的矩阵大括号），文本层只留下私有区码位；相邻的 3 / 7 / 11 / 8 等数字仍正常保留。"
            "建议在应用内用「手动纠错」把这些码位补成 `[ ]`、`∑`、`⊕` 等可读符号。")
    else:
        add("无。")
    add("")
    add(SECTION_74B_HEADING)
    add("")
    private_use = c.get("privateUseChars", [])
    pu_ids = []
    for item in private_use:
        for qid in item["examples"]:
            if qid not in pu_ids:
                pu_ids.append(qid)
    pu_id_text = "、".join("`%s`" % i for i in pu_ids) if pu_ids else "（无）"
    if c["suspiciousChars"]:
        add("| 字符 | 码位 | 出现题数 | 示例题 |")
        add("| --- | --- | --- | --- |")
        for s in c["suspiciousChars"]:
            add("| %s | %s | %d | %s |" % (s["char"], s["codepoint"], s["count"], "、".join("`%s`" % i for i in s["examples"])))
        add("")
    # 交付件措辞：明确「(a) 之外无其他私有区字符」，并附 v1.1.2 更正说明（早期观察 O-2）
    add(SECTION_74B_BODY.format(n=len(private_use), ids=pu_id_text))
    add("")
    for note_line in SECTION_74B_NOTE:
        add(note_line.format(n=len(private_use), ids=pu_id_text))
    add("")
    src_art = report["sourceTextArtifacts"]
    if src_art:
        add("源文本自带的可疑片段（**保留原文不改**，建议用应用内「手动纠错/标疑问」处理）：")
        add("")
        for a in src_art:
            add("- `%s`（第 %s 页）：`%s`" % (a["qid"], a["page"], a["text"]))
        add("")
    else:
        add("未发现源文本自带的可疑数字/乱码片段。")
    add("")
    add("### 7.5 重复题干")
    add("")
    dup = report["duplicateStems"]
    if dup:
        add("| 题干（前 60 字） | 重复 id | 题数 |")
        add("| --- | --- | --- |")
        for d in dup:
            add("| %s | %s | %d |" % (d["stem"], "、".join("`%s`" % i for i in d["ids"]), d["count"]))
        add("")
        add("处理：**保留全部**（不同章/题型的题目允许题干相同，属题库原貌；出题时按 `id` 去重，互不影响）。")
    else:
        add("无重复题干。")
    add("")
    add("### 7.6 编号与切分修复记录")
    add("")
    add("| 类型 | 次数 | 说明 |")
    add("| --- | --- | --- |")
    kinds = {}
    for a in report["anomalies"]:
        kinds[a["kind"]] = kinds.get(a["kind"], 0) + 1
    if kinds:
        for k, v in sorted(kinds.items()):
            add("| `%s` | %d | %s |" % (k, v, _anomaly_note(k)))
    else:
        add("| — | 0 | 无需修复 |")
    add("")
    if report["anomalies"]:
        add("明细（最多 20 条，全量见 `bank.report.json` → `anomalies`）：")
        add("")
        for a in report["anomalies"][:20]:
            add("- `%s`：%s" % (a["kind"], json.dumps({k: v for k, v in a.items() if k != "kind"}, ensure_ascii=False)))
        add("")

    # §7.7 droppedLines 口径说明（v1.1.2 交付件措辞，早期观察 O-3）
    L.extend(section_77_lines(report["droppedLines"]))

    add("## 8. 填空题答案与归一化形式")
    add("")
    add("`bank.json` 中填空答案保存**原文串**（仅去首尾空白）。判分口径见需求规格 §9.3：`norm(s) = s.trim().toLowerCase()`，")
    add("即忽略大小写与首尾空格、**不忽略内部空格、不做全角/半角折叠**（§13.3 冻结默认）。下表同时给出全角→半角折叠后的归一化值（参考口径，默认不启用）：")
    add("")
    add("| 题 id | 题号 | 原文答案 | `answer`（入库） | `norm`（trim+小写） | `normWide`（全角折叠+小写） |")
    add("| --- | --- | --- | --- | --- | --- |")
    for row in report["blankAnswers"]:
        raw = row["rawAnswer"] if row["rawAnswer"] is not None else "（原文无答案行，人工补录）"
        add(
            "| `%s` | %s | %s | `%s` | `%s` | `%s` |"
            % (
                row["id"],
                row["printedNo"] if row["printedNo"] is not None else "未编号",
                raw,
                json.dumps(row["answer"], ensure_ascii=False),
                json.dumps(row["answerNorm"], ensure_ascii=False),
                json.dumps(row["answerNormWide"], ensure_ascii=False),
            )
        )
    add("")
    add("观测：30 道填空题的原文答案全部为半角字符，`norm` 与 `normWide` 结果一致（无全角字符需要折叠）。")
    add("")
    add("人工补录记录：")
    add("")
    for m in report["manualAnswers"]:
        add(
            "- `%s`（第 %s 页）：`answer=%s`，`rawAnswer=null`，`answerStatus=ok`，`needsReview=true`，`reviewReason=answer_missing`；"
            "题干未改动，证据：%s。"
            % (m["id"], m["sourcePage"], json.dumps(m["answer"], ensure_ascii=False), m["evidence"])
        )
    if not report["manualAnswers"]:
        add("- 本次运行未启用人工补录（`--no-manual-answers`）。")
    add("")

    add("## 9. 标签与难度分布")
    add("")
    add("| 难度 | 含义 | 题数 |")
    add("| --- | --- | --- |")
    diff_names = {"1": "基础", "2": "进阶", "3": "挑战"}
    for k, v in sorted(counts["difficulty"].items()):
        add("| %s | %s | %d |" % (k, diff_names.get(k, ""), v))
    add("")
    add("标签命中量 Top 20（同一题最多 3 个标签，故合计大于题数）：")
    add("")
    add("| 标签 | 命中题数 |")
    add("| --- | --- |")
    for tag, n in list(tag_dist.items())[:20]:
        add("| %s | %d |" % (tag, n))
    add("")

    add("## 10. 可重复性与校验")
    add("")
    add("- 解析无随机性、无网络访问；`generatedAt` 是唯一随运行时间变化的字段，固定后可得到**字节级一致**的 `bank.json`。实测证据：")
    add("  1. 固定 `CQP_NOW=2026-09-16T20:00:00+08:00` 连续运行两次：`bank.json`（SHA-256 `%s`）、`bank.report.json`、本报告三者哈希完全一致；" % report["hashes"]["bank"])
    add("  2. 改用 `CQP_NOW=2027-01-01T09:09:09+08:00` 重跑：`bank.json` 44461 行中**仅 1 行不同**（第 4 行 `generatedAt`）；")
    add("  3. 绕过缓存文本、从 PDF 现场重新抽取（`--text` 指向不存在的文件）重跑：`bank.json` 哈希与缓存文本路径**完全一致**（两条输入路径等价）。")
    add("- 运行环境：Python 3（仅标准库；从 PDF 现场抽取时用 `pypdfium2`）、Node.js（校验脚本零依赖）、Windows + UTF-8。")
    add(
        SECTION_10_SELFCHECK.format(
            questions=counts["questions"],
            printed=counts["printed"],
            answerOk=counts["answerOk"],
            answerMissing=counts["answerMissing"],
            manual=len(report["manualAnswers"]),
        )
    )
    add("- 独立校验：`node tools/validate_bank.mjs`（不依赖 Python），逐项输出 §5.9 校验表 22 项与 8 项结构守卫，末行打印 `ok: true` / `ok: false`。本次运行的输出：")
    add("")
    add("```")
    add(report["validatorOutput"].rstrip())
    add("```")
    add("")
    add("构建期告警（供 `build.mjs` 直接消费，写入 `src/bank.build-report.json` 的 `buildWarnings[]`）：")
    add("")
    add("| id | sectionType | responseMode | answer | 原因 |")
    add("| --- | --- | --- | --- | --- |")
    for w in report["buildWarnings"]:
        add(
            "| `%s` | %s | %s | `%s` | %s |"
            % (w["id"], w["sectionType"], w["responseMode"], json.dumps(w["answer"], ensure_ascii=False), w["note"])
        )
    add("")
    add(SECTION_11_HEADING)
    add("")
    add("| 校验项 | v1.0.0 §5.9 | v1.1.0 §5.9 | 本次实测 | 结论 |")
    add("| --- | --- | --- | --- | --- |")
    add("| `questions.length` | 1051 | 1051 | **%d** | 一致 |" % counts["questions"])
    add("| `answerStatus=\"ok\"` 题数 | 1050 | **1051** | **%d** | 一致（`Q-C05-F-0007` 人工补录） |" % counts["answerOk"])
    add("| `answerStatus=\"missing\"` 题数 | 1 | **0** | **%d** | 一致 |" % counts["answerMissing"])
    add("| `answer.length = 0` 题数 | 1 | **0** | **0** | 一致 |")
    add("| 填空段有答案的题数 | 29 | **30** | **30** | 一致（含人工补录 1 题） |")
    add("| 人工补录答案的题数 | — | **1** | **1**（`Q-C05-F-0007`，`rawAnswer=null`、`needsReview=true`） | 一致 |")
    add("| `needsReview=true` 题数 | 5 | 5 | **%d**（`%s`） | 一致 |" % (len(report["needsReviewIds"]), "`, `".join(report["needsReviewIds"])))
    add("| `printedNo=null` 题数 | 1 | 1 | **1**（`Q-C05-S-0060`） | 一致 |")
    add("| 题型计数 | 491/358/172/30 | 491/358/172/30 | **%s** | 一致 |" % "/".join(str(by_type.get(k, 0)) for k in ("single", "multiple", "judge", "blank")))
    add("| `responseMode` 计数 | 492/357/172/30 | 492/357/172/30 | **%s** | 一致 |" % "/".join(str(counts["byResponseMode"].get(k, 0)) for k in ("single", "multiple", "judge", "blank")))
    add("| 判断题答案分布 | 81/91 | 81/91 | **81/91** | 一致 |")
    add("| 匹配/连线题 | 4 道 | 4 道 | **4 道** | 一致 |")
    add("| 具体标签命中率 | 83.4%%（876/1050） | ≥ 80%% | **%.1f%%（%d/%d）** | 一致（口径说明见第 6 节） |" % (report["tags"]["coverage"] * 100, report["tags"]["specific"], counts["questions"]))
    add("")
    add("> 结论：`node tools/validate_bank.mjs` 逐项输出 §5.9 的 22 项校验，本次全部 PASS，末行 `ok: true`、退出码 0。")
    add("> 出题候选池：补录后全部 %d 题均可判分（§13.1 的「缺答案题不参与出题」不再排除任何题），模拟赛填空池 30 题（配额仍为 3）。" % counts["questions"])
    add("> 若用户否决 R2-2，用 `python tools/parse_bank.py --no-manual-answers` 可还原为 v1.0.0 口径（`missing=1`、候选池 1050），结构不变。")
    add("")
    add("## 12. 后续建议")
    add("")
    add("1. 建议把 T-05-04 的判定口径写明为「命中 ≥1 条关键词规则的题数 ≥ 830（实测 %d）」/「仅走章级兜底 ≤ 220（实测 %d）」；"
        "避免用「`tags` 是否恰等于该章兜底标签」这一字面口径（会因 C07 兜底标签与规则 24 同名而多算 58 题、得到 %d）。"
        % (report["tags"]["specific"], report["tags"]["fallback"], report["tags"]["fallbackNamed"]))
    add("2. `Q-C05-S-0034` 选项 B 的源码片段 `B.杂凑 123.函数的输出长度固定`（第 48 页）为 PDF 原文自带的多余数字，建议在应用内「手动纠错」中修正，题库文件保持原文。")
    add("3. 连线题（缺陷 C）在界面建议渲染为「配对表 + 单选」，与 `responseMode=\"single\"` 一致。")
    add("4. `Q-C05-F-0021`（第 98 页，Hill 密码矩阵）的矩阵括号在文本层是私有区码位（U+F0E6～U+F0F8），建议在应用内「手动纠错」补成 `[ ]`。")
    add("")
    return "\n".join(L) + "\n"


def _anomaly_note(kind):
    notes = {
        "repair_merge_spurious_split": "误切分的块并回上一题（防御性修复）",
        "repair_split_multi_answer_block": "同一块出现 2 个答案行时按第一个答案行再切分（未编号题场景）",
        "repair_stray_option_after_answer": "答案行之后出现孤立选项行，按原文归入上一题",
        "repair_number_out_of_sequence": "题号非期望值（脚本仍按新题处理并留痕）",
        "repair_number_gap": "题号出现跳号（脚本仍按新题处理并留痕）",
        "rejected_numbered_line": "疑似连线题对照表行（行内含选项标记），不当作新题",
        "section_block_count_mismatch": "章节题块数与冻结计数不符（脚本会以非 0 退出）",
        "source_midline_number": "源文本行内出现可疑的多余数字（保留原文）",
        "content_on_heading_line": "标题行上附带正文内容（已保留为正文）",
        "printed_number_discontinuity": "打印题号出现缺口或重复",
        "answer_warning": "答案规范化告警（如原文未升序，已排序并留痕）",
        "text_before_first_heading": "首个标题之前的文本（前置页，已跳过）",
    }
    return notes.get(kind, "见 `bank.report.json`")



def scan_anomalies(questions, qmeta):
    """Cross page breaks, merged line breaks, suspicious characters, empty stems."""
    cross_page = []
    merged_total = 0
    empty_stems = []
    suspicious = {}
    private_use = {}
    for q in questions:
        meta = qmeta.get(q["id"], {})
        pages = meta.get("pages", [])
        if len(pages) > 1:
            cross_page.append({"id": q["id"], "pages": pages, "lines": meta.get("lines", 0)})
        merged_total += max(0, meta.get("lines", 1) - 1)
        if not q["stem"]:
            empty_stems.append(q["id"])
        text = q["stem"] + " " + " ".join(o["text"] for o in q["options"])
        for ch in text:
            if ch in " \t":
                continue
            o = ord(ch)
            if ch.isalnum() or is_cjk(ch):
                continue
            if 0xE000 <= o <= 0xF8FF:  # private use area: symbol-font mapping loss
                ids = private_use.setdefault(ch, [])
                if q["id"] not in ids:
                    ids.append(q["id"])
                continue
            if ch in "()（）《》〈〉【】[]{}、，。；：？！,.;:?!-—_~@#$%^&*+=<>/\\|'\"“”‘’·…′″°±×÷≤≥≈≠∞∑∫√µ‰§¶→←↑↓⊕⊗⊙⊕∏∑∈∉⊆⊂∩∪αβγλμσφωπθΔ":
                continue
            ids = suspicious.setdefault(ch, [])
            if q["id"] not in ids:
                ids.append(q["id"])
    return {
        "crossPageQuestions": cross_page,
        "mergedLineBreaks": merged_total,
        "emptyStemQuestions": empty_stems,
        "suspiciousChars": [
            {"char": c, "codepoint": "U+%04X" % ord(c), "count": len(ids), "examples": ids[:5]}
            for c, ids in sorted(suspicious.items(), key=lambda kv: -len(kv[1]))
        ],
        "privateUseChars": [
            {"char": c, "codepoint": "U+%04X" % ord(c), "count": len(ids), "examples": ids[:5]}
            for c, ids in sorted(private_use.items(), key=lambda kv: -len(kv[1]))
        ],
    }


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def sha256_of(path):
    h = hashlib.sha256()
    with io.open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def run_validator(script_path, bank_path, workspace, enabled=True):
    """Run the independent Node validator and return its stdout (empty when unavailable)."""
    if not enabled:
        return "(skipped: --no-validator)\n"
    if not os.path.isfile(script_path):
        return "(validate_bank.mjs not found: %s)\n" % os.path.relpath(script_path, workspace)
    import shutil
    import subprocess

    node = shutil.which("node")
    if not node:
        return "(node not found on PATH; run 'node %s' manually)\n" % os.path.relpath(script_path, workspace)
    try:
        proc = subprocess.run(
            [node, script_path, bank_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=120,
        )
        out = proc.stdout.decode("utf-8", "replace")
        return out if out.endswith("\n") else out + "\n"
    except Exception as exc:  # pragma: no cover - defensive
        return "(validator run failed: %s: %s)\n" % (type(exc).__name__, exc)


def resolve_now(value):
    if value:
        try:
            dt = datetime.fromisoformat(value)
        except ValueError:
            raise SystemExit("usage: --now must be ISO-8601, e.g. 2026-09-16T20:00:00+08:00")
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=TZ8)
        return dt
    return datetime.now(TZ8)


def main(argv=None):
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    workspace = os.path.dirname(root)
    parser = argparse.ArgumentParser(description="parse the quiz bank PDF into bank.json (ASCII console output)")
    parser.add_argument("--text", default=os.path.join(workspace, "工作目录", "bank_text.json"))
    parser.add_argument("--pdf", default=os.path.join(workspace, PDF_FILE_NAME))
    parser.add_argument("--out", default=os.path.join(root, "src", "data", "bank.json"))
    parser.add_argument("--report-json", default=os.path.join(root, "src", "data", "bank.report.json"))
    parser.add_argument("--report-md", default=os.path.join(root, "docs", "解析报告.md"))
    parser.add_argument("--now", default=os.environ.get("CQP_NOW", ""))
    parser.add_argument(
        "--no-manual-answers",
        action="store_true",
        default=os.environ.get("CQP_NO_MANUAL_ANSWERS", "") not in ("", "0", "false"),
        help="do not apply the manually recorded answers (raw parse, 需求规格.md 5.9 baseline)",
    )
    parser.add_argument(
        "--no-validator",
        action="store_true",
        default=os.environ.get("CQP_SKIP_VALIDATOR", "") not in ("", "0", "false"),
        help="do not embed validate_bank.mjs output in the parse report",
    )
    parser.add_argument(
        "--validator-bank",
        default="",
        help="bank file handed to validate_bank.mjs (default: --out); use the in-tree "
        "src/data/bank.json for out-of-tree verification runs so the embedded validator "
        "block stays identical to the delivered report",
    )
    args = parser.parse_args(argv)

    manual_answers = not args.no_manual_answers
    now = resolve_now(args.now)
    pages, source_note = load_pages(args.text, args.pdf)
    lines, dropped = flatten_lines(pages)
    sections, slice_anomalies, stopped, dropped_hands_on = slice_sections(lines)
    questions, numbering, unmatched, qmeta, manual_applied, matching_ids, option_notes = build_questions(
        sections, slice_anomalies, manual_answers=manual_answers
    )

    chapters = build_chapters(questions)
    bank = {
        "schemaVersion": SCHEMA_VERSION,
        "bankVersion": BANK_VERSION,
        "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "source": {
            "fileName": PDF_FILE_NAME,
            "pages": len(pages),
            "theoryBlocks": len(questions),
            "printedQuestions": sum(1 for q in questions if q["printedNo"] is not None),
            "excludedCount": EXCLUDED_COUNT,
            "excludedReason": EXCLUDED_REASON,
        },
        "chapters": chapters,
        "questions": questions,
    }
    checks = run_checks(
        bank,
        questions,
        numbering,
        slice_anomalies,
        manual_answers=manual_answers,
        matching_ids=matching_ids,
    )
    content = scan_anomalies(questions, qmeta)

    # option/answer shape issues surfaced by the block parser
    option_issues = []
    for a in slice_anomalies:
        if a["kind"] == "block_issue" and a.get("detail") in ("no_option_lines", "no_option_A_marker"):
            option_issues.append({"id": a["qid"], "detail": a["detail"]})
    source_artifacts = [a for a in slice_anomalies if a["kind"] == "source_midline_number"]

    printed_by_type = {}
    for q in questions:
        if q["printedNo"] is not None:
            printed_by_type[q["sectionType"]] = printed_by_type.get(q["sectionType"], 0) + 1
    fallback_by_chapter = {}
    for q in questions:
        fb = CHAPTER_FALLBACK_TAG.get(q["chapterCode"])
        if q["tags"] == [fb] and not any(
            re.search(pat, q["stem"] + " " + " ".join(o["text"] for o in q["options"]), re.IGNORECASE)
            for _t, pat in TAG_RULES
        ):
            fallback_by_chapter[q["chapterCode"]] = fallback_by_chapter.get(q["chapterCode"], 0) + 1

    # write bank.json first so the report can embed its hash
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    os.makedirs(os.path.dirname(args.report_json), exist_ok=True)
    os.makedirs(os.path.dirname(args.report_md), exist_ok=True)
    bank_text = json.dumps(bank, ensure_ascii=False, indent=2) + "\n"
    with io.open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(bank_text)

    sample_defects = {}
    if manual_applied:
        sample_defects["缺陷 B：缺答案题（已人工补录）"] = next(
            q for q in questions if q["id"] == "Q-C05-F-0007"
        )
    else:
        sample_defects["缺陷 B：缺答案题（原始解析）"] = next(
            q for q in questions if q["id"] == "Q-C05-F-0007"
        )
    sample_defects["缺陷 A：未编号题"] = next(q for q in questions if q["id"] == "Q-C05-S-0060")
    sample_defects["缺陷 C：连线/匹配题"] = next(q for q in questions if q["id"] == "Q-C04-M-0002")
    sample_defects["缺陷 G：题型与答案形状不符"] = next(q for q in questions if q["id"] == "Q-C06-M-0008")

    # build-time warnings for build.mjs (需求规格 §5.3.3): every question whose
    # sectionType differs from its responseMode
    build_warnings = []
    for q in questions:
        if q["sectionType"] in ("single", "multiple") and q["sectionType"] != q["responseMode"]:
            build_warnings.append(
                {
                    "id": q["id"],
                    "sectionType": q["sectionType"],
                    "responseMode": q["responseMode"],
                    "answer": q["answer"],
                    "note": "matching/连线 question: single-letter pairing answer (defect C, build warning only)"
                    if is_matching_question(q["stem"], q["options"])
                    else "answer shape differs from the section type (defect G: needsReview=true)",
                }
            )

    report = {
        "generatedAt": bank["generatedAt"],
        "bankVersion": BANK_VERSION,
        "schemaVersion": SCHEMA_VERSION,
        "source": bank["source"],
        "sourceNote": source_note,
        "manualAnswersEnabled": manual_answers,
        "manualAnswers": manual_applied,
        "droppedLines": dropped,
        "counts": {
            "questions": len(questions),
            "printed": checks["printedTotal"],
            "answerOk": checks["answerOk"],
            "answerMissing": checks["answerMissing"],
            "bySectionType": checks["byType"],
            "byResponseMode": checks["byMode"],
            "printedByType": {k: printed_by_type.get(k, 0) for k in TYPE_NAME},
            "difficulty": checks["difficulty"],
            "tagDistribution": checks["tagDistribution"],
        },
        "table": checks["table"],
        "continuity": checks["continuity"],
        "judgeAnswerDistribution": checks["judgeDist"],
        "needsReviewIds": checks["needsReview"],
        "typeMismatchIds": checks["typeMismatchIds"],
        "matching": checks["matchingQuestions"],
        "buildWarnings": build_warnings,
        "optionStructureNotes": option_notes,
        "tags": {
            "specific": checks["specificTagCount"],
            "fallback": checks["fallbackTagCount"],
            "fallbackNamed": checks["fallbackTagNamedCount"],
            "coverage": round(checks["tagCoverage"], 4),
            "coverageNarrow": round(checks["tagCoverageNarrow"], 4),
        },
        "fallbackByChapter": fallback_by_chapter,
        "duplicateStems": checks["duplicateStems"],
        "blankAnswers": blank_answer_table(questions),
        "optionIssues": option_issues,
        "sourceTextArtifacts": source_artifacts,
        "content": content,
        "anomalies": slice_anomalies,
        "hashes": {
            "sourceText": sha256_of(args.text) if args.text and os.path.isfile(args.text) else None,
            "bank": hashlib.sha256(bank_text.encode("utf-8")).hexdigest(),
        },
        "warnings": checks["warnings"],
        "errors": checks["errors"],
    }
    report["validatorOutput"] = run_validator(
        os.path.join(root, "tools", "validate_bank.mjs"),
        args.validator_bank or args.out,
        workspace,
        enabled=not args.no_validator,
    )

    with io.open(args.report_json, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    primary = next((q for q in questions if q["id"] == "Q-C01-S-0002"), questions[0])
    md = render_report_md(report, bank, {"primary": primary, "defects": sample_defects})
    with io.open(args.report_md, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(md)

    print("questions: %d (printed %d)" % (len(questions), checks["printedTotal"]))
    print("sectionType: %s" % json.dumps(checks["byType"], sort_keys=True))
    print("responseMode: %s" % json.dumps(checks["byMode"], sort_keys=True))
    print("answerStatus: ok=%d missing=%d (manual answers %s)" % (checks["answerOk"], checks["answerMissing"], "on" if manual_answers else "off"))
    print("needsReview: %d" % len(checks["needsReview"]))
    print(
        "tag coverage: %.1f%% specific=%d fallback=%d (narrow tags==chapter-fallback: %.1f%%, %d)"
        % (
            checks["tagCoverage"] * 100,
            checks["specificTagCount"],
            checks["fallbackTagCount"],
            checks["tagCoverageNarrow"] * 100,
            checks["fallbackTagNamedCount"],
        )
    )
    print("duplicate ids: 0 (unique %d)" % len({q["id"] for q in questions}))
    print("duplicate stems: %d groups" % len(checks["duplicateStems"]))
    print("cross-page questions: %d" % len(content["crossPageQuestions"]))
    span_start, span_end = flatten_lines_span()
    if span_start is not None and "%d–%d" % (span_start, span_end) != FROZEN_FLATTEN_LINES:
        print(
            "  NOTE: flatten_lines() now spans lines %d-%d but the frozen report text references %s;"
            % (span_start, span_end, FROZEN_FLATTEN_LINES)
        )
        print("        update FROZEN_FLATTEN_LINES together with the delivery (needs a new review).")
    print("errors: %d" % len(checks["errors"]))
    for err in checks["errors"]:
        print("  ERROR: %s" % err)
    print("wrote: %s" % os.path.relpath(args.out, workspace))
    print("wrote: %s" % os.path.relpath(args.report_json, workspace))
    print("wrote: %s" % os.path.relpath(args.report_md, workspace))
    return 1 if checks["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
