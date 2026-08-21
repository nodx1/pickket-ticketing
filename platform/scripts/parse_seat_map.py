#!/usr/bin/env python3
"""
브랜든리 컬렉션 콘서트 좌석배치도 Excel -> JSON 파서

Excel 파일은 시각적 좌석 배치도로, 셀 위치가 물리적 좌석 위치를 나타냄.

등급 판별: 셀 배경색 기반
  Red(10)→R, Gold(51)→S, Yellow(13)→A, Green(17)→B, Cyan(40)→C
  진파랑(56)/회색(55)/보라(36) → 시야방해 좌석
  흰색(9) → 행라벨/배경 (제외)

행라벨: 아래 열에 위치한 비시안/비시야방해 셀은 행번호 표시
  전역: {2, 3, 11, 23, 27, 29, 34, 56, 60, 63, 67, 79, 80, 87, 88}
  시안(C등급)과 시야방해 색상은 라벨 열에서도 좌석으로 유지
"""

import json
from collections import Counter
from pathlib import Path

import xlrd

XLS_PATH = Path.home() / "Downloads" / "좌석배치도_브랜든리컬렉션콘서트.xls"
OUT_PATH = Path(__file__).parent / "data" / "brandon_lee_seat_map.json"
SHEET_NAME = "7.26 좌석배치도"

MAP_WIDTH = 1000
MAP_HEIGHT = 800

COLOR_GRADE = {10: "R", 51: "S", 13: "A", 17: "B", 40: "C"}
OBSTRUCTED_COLORS = {56, 55, 36}
WHITE = 9
CYAN = 40

# 라벨 열에서도 좌석으로 유지하는 색상
FORCE_SEAT_COLORS = OBSTRUCTED_COLORS | {CYAN}

# 행라벨 열: (r1, r2, cols) - 해당 행 범위에서만 라벨로 간주
LABEL_RULES = [
    (4, 31, {11}),           # 2F LP: col 11 = row#
    (4, 9, {29, 60}),        # 2F center: edge row labels
    (14, 31, {2}),           # 2F L: col 2 = row#
    (14, 31, {88}),          # 2F R: col 88 = row#
    (33, 51, {2, 3}),        # 1F L upper + 2F L lower: cols 2,3
    (33, 51, {87, 88}),      # 1F R upper + 2F R lower: cols 87,88
    (49, 74, {27, 29, 34}),  # 1F CB: row labels
    (49, 74, {56, 60, 63}),  # 1F CD: row labels
    (52, 67, {23, 67}),      # 1F A/E inner row labels
    (80, 87, {11, 34, 80}),  # 2F lower: row labels (NOT col 56 - it's a seat here)
]

# 구역 정의
SECTIONS = [
    # (id, floor, name, label, r1, r2, c1, c2)
    ("2F-LP", 2, "2층 좌측 전방",   "LP",        4, 31, 11, 19),
    ("2F-RP", 2, "2층 우측 전방",   "RP",        4, 31, 71, 79),
    ("2F-L",  2, "2층 좌측",       "L",        14, 51,  2,  4),
    ("2F-R",  2, "2층 우측",       "R",        14, 51, 86, 88),
    ("1F-CC", 1, "1층 중앙 (C)",   "C",        49, 74, 35, 55),
    ("1F-CB", 1, "1층 중앙좌 (B)",  "B",        49, 74, 23, 34),
    ("1F-CD", 1, "1층 중앙우 (D)",  "D",        49, 74, 56, 68),
    ("1F-L",  1, "1층 좌측 (A)",   "A",        32, 67,  5, 22),
    ("1F-R",  1, "1층 우측 (E)",   "E",        32, 67, 69, 85),
    ("2F-BL", 2, "2층 하단 좌측",   "L-rear",   80, 87, 12, 22),
    ("2F-BC", 2, "2층 하단 중앙",   "C-rear",   80, 87, 24, 67),
    ("2F-BR", 2, "2층 하단 우측",   "R-rear",   80, 87, 69, 79),
]

SECTION_BASE_GRADE = {
    "1F-L": "A", "1F-R": "A",
    "1F-CB": "R", "1F-CC": "R", "1F-CD": "R",
    "2F-LP": "B", "2F-RP": "B",
    "2F-L": "C", "2F-R": "C",
    "2F-BL": "A", "2F-BC": "S", "2F-BR": "A",
}


def find_section(row, col):
    best = None
    best_area = float("inf")
    for sec in SECTIONS:
        sid, _, _, _, r1, r2, c1, c2 = sec
        if r1 <= row <= r2 and c1 <= col <= c2:
            area = (r2 - r1 + 1) * (c2 - c1 + 1)
            if area < best_area:
                best_area = area
                best = sec
    return best


def parse_seat_map():
    wb = xlrd.open_workbook(str(XLS_PATH), formatting_info=True)
    sh = wb.sheet_by_name(SHEET_NAME)

    PRICING_AREA = (11, 31, 27, 69)
    raw = {}

    for r in range(sh.nrows):
        for c in range(sh.ncols):
            if sh.cell_type(r, c) != 2:
                continue
            v = sh.cell_value(r, c)
            if v == 0 or v == "" or v != int(v):
                continue

            pr1, pr2, pc1, pc2 = PRICING_AREA
            if pr1 <= r <= pr2 and pc1 <= c <= pc2:
                continue

            xf = wb.xf_list[sh.cell_xf_index(r, c)]
            fg_idx = xf.background.pattern_colour_index

            # 흰색 제외
            if fg_idx == WHITE:
                continue

            # 라벨 열 체크 (시안/시야방해 제외)
            if fg_idx not in FORCE_SEAT_COLORS:
                is_label = False
                for lr1, lr2, lcols in LABEL_RULES:
                    if lr1 <= r <= lr2 and c in lcols:
                        is_label = True
                        break
                if is_label:
                    continue

            sec = find_section(r, c)
            if sec is None:
                continue

            raw[(r, c)] = (int(v), fg_idx, sec[0])

    # ── 등급 결정 ──────────────────────────────────────────────
    seats = []
    grade_stats = Counter()
    section_stats = Counter()

    for (r, c), (seat_num, fg_idx, sec_id) in raw.items():
        is_obstructed = fg_idx in OBSTRUCTED_COLORS

        if fg_idx in COLOR_GRADE:
            grade = COLOR_GRADE[fg_idx]
        elif is_obstructed:
            nbg = []
            for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1),
                           (-1, -1), (-1, 1), (1, -1), (1, 1)]:
                nb = raw.get((r + dr, c + dc))
                if nb and nb[1] in COLOR_GRADE:
                    nbg.append(COLOR_GRADE[nb[1]])
            base = Counter(nbg).most_common(1)[0][0] if nbg else SECTION_BASE_GRADE.get(sec_id, "A")
            grade = f"시방{base}"
        else:
            grade = SECTION_BASE_GRADE.get(sec_id, "A")

        r1 = next(s[4] for s in SECTIONS if s[0] == sec_id)
        seat_row = str(r - r1 + 1)

        x = int(c / sh.ncols * MAP_WIDTH)
        y = int(r / sh.nrows * MAP_HEIGHT)

        seat = {
            "section": sec_id,
            "row": seat_row,
            "number": seat_num,
            "grade": grade,
            "x": x,
            "y": y,
        }
        if is_obstructed:
            seat["obstructed"] = True

        seats.append(seat)
        grade_stats[grade] += 1
        section_stats[sec_id] += 1

    return seats, section_stats, grade_stats


def build_output(seats):
    sections_out = [{"id": s[0], "floor": s[1], "name": s[2], "label": s[3]}
                    for s in SECTIONS]

    tiers = [
        {"grade": "R",   "price": 99000, "capacity": 492, "is_obstructed": False},
        {"grade": "S",   "price": 88000, "capacity": 481, "is_obstructed": False},
        {"grade": "A",   "price": 77000, "capacity": 460, "is_obstructed": False},
        {"grade": "B",   "price": 55000, "capacity": 184, "is_obstructed": False},
        {"grade": "C",   "price": 15000, "capacity": 122, "is_obstructed": False},
        {"grade": "시방R", "price": 69300, "capacity": 14, "is_obstructed": True},
        {"grade": "시방S", "price": 61600, "capacity": 16, "is_obstructed": True},
        {"grade": "시방A", "price": 53900, "capacity": 42, "is_obstructed": True},
    ]

    return {
        "venue": {
            "name": "브랜든리 컬렉션 콘서트",
            "map_width": MAP_WIDTH,
            "map_height": MAP_HEIGHT,
        },
        "sections": sections_out,
        "tiers": tiers,
        "seats": seats,
    }


def main():
    print(f"파싱 중: {XLS_PATH}")
    print(f"시트: {SHEET_NAME}\n")

    seats, section_stats, grade_stats = parse_seat_map()

    print(f"=== 파싱 결과 ===")
    print(f"총 좌석 수: {len(seats)}\n")

    print("── 구역별 좌석 수 ──")
    for sid, floor, name, *_ in SECTIONS:
        cnt = section_stats.get(sid, 0)
        print(f"  {sid:10s} {name:15s}: {cnt:4d}석")
    print(f"  {'합계':>26s}: {sum(section_stats.values()):4d}석\n")

    print("── 등급별 좌석 수 ──")
    expected = {"R": 492, "S": 481, "A": 460, "B": 184, "C": 122,
                "시방R": 14, "시방S": 16, "시방A": 42}
    for grade in ["R", "S", "A", "B", "C", "시방R", "시방S", "시방A"]:
        actual = grade_stats.get(grade, 0)
        exp = expected[grade]
        diff = actual - exp
        marker = " OK" if diff == 0 else f" ({diff:+d})"
        print(f"  {grade:6s}: {actual:4d}석 (기대: {exp:>4}){marker}")
    for grade, count in sorted(grade_stats.items()):
        if grade not in expected:
            print(f"  {grade:6s}: {count:4d}석 (미예상)")
    print()

    output = build_output(seats)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"JSON 저장: {OUT_PATH}")
    print(f"파일 크기: {OUT_PATH.stat().st_size / 1024:.1f} KB")

    total_exp = sum(expected.values())
    diff = len(seats) - total_exp
    if diff == 0:
        print(f"\n총 좌석 수 {total_exp}석 정확히 일치!")
    else:
        pct = abs(diff) / total_exp * 100
        print(f"\n기대 총 좌석 수({total_exp})와 {abs(diff)}석 차이 "
              f"({'초과' if diff > 0 else '부족'}, {pct:.1f}%)")


if __name__ == "__main__":
    main()
