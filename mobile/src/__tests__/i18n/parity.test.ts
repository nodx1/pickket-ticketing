/**
 * i18n 키 정합성 테스트 — ko/en 키셋 일치 검증
 *
 * 한쪽에만 존재하는 키가 있으면 빌드 실패시킴.
 * 누락된 번역으로 인한 미번역 텍스트 노출 방지.
 */
import ko from "@/i18n/locales/ko.json";
import en from "@/i18n/locales/en.json";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
  [k: string]: JsonValue;
}

function flatten(obj: JsonObject, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flatten(v as JsonObject, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe("i18n parity", () => {
  const koKeys = flatten(ko as JsonObject);
  const enKeys = flatten(en as JsonObject);

  it("ko / en 키셋 동일", () => {
    const onlyInKo = koKeys.filter((k) => !enKeys.includes(k));
    const onlyInEn = enKeys.filter((k) => !koKeys.includes(k));

    if (onlyInKo.length || onlyInEn.length) {
      const msg = [
        onlyInKo.length ? `ko에만 있음 (${onlyInKo.length}):\n  ${onlyInKo.join("\n  ")}` : "",
        onlyInEn.length ? `en에만 있음 (${onlyInEn.length}):\n  ${onlyInEn.join("\n  ")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      throw new Error(msg);
    }

    expect(onlyInKo).toEqual([]);
    expect(onlyInEn).toEqual([]);
  });

  it("ko 빈 값 없음", () => {
    function findEmpty(obj: JsonObject, prefix = ""): string[] {
      const empty: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v === "" || v === null) empty.push(path);
        else if (typeof v === "object" && !Array.isArray(v)) {
          empty.push(...findEmpty(v as JsonObject, path));
        }
      }
      return empty;
    }

    expect(findEmpty(ko as JsonObject)).toEqual([]);
  });

  it("en 빈 값 없음", () => {
    function findEmpty(obj: JsonObject, prefix = ""): string[] {
      const empty: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v === "" || v === null) empty.push(path);
        else if (typeof v === "object" && !Array.isArray(v)) {
          empty.push(...findEmpty(v as JsonObject, path));
        }
      }
      return empty;
    }

    expect(findEmpty(en as JsonObject)).toEqual([]);
  });
});
