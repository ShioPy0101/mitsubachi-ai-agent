const whitespacePattern = /[\s\u3000]+/gu;
const kanaVariantPattern = /[ゕゖヵヶ]/gu;
const voicedKaPattern = /[がガ]/gu;

function katakanaToHiragana(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0x30a1 && codePoint <= 0x30f6) {
      return String.fromCodePoint(codePoint - 0x60);
    }
    return character;
  }).join("");
}

export function normalizeStationName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(whitespacePattern, "")
    .replace(kanaVariantPattern, "ケ");
}

export function normalizeKana(value: string): string {
  return katakanaToHiragana(value.normalize("NFKC"))
    .replace(whitespacePattern, "")
    .replace(kanaVariantPattern, "か")
    .replace(voicedKaPattern, "か")
    .replace(
      /[ぁぃぅぇぉっゃゅょゎ]/gu,
      (character) =>
        ({
          ぁ: "あ",
          ぃ: "い",
          ぅ: "う",
          ぇ: "え",
          ぉ: "お",
          っ: "つ",
          ゃ: "や",
          ゅ: "ゆ",
          ょ: "よ",
          ゎ: "わ",
        })[
          character as
            "ぁ" | "ぃ" | "ぅ" | "ぇ" | "ぉ" | "っ" | "ゃ" | "ゅ" | "ょ" | "ゎ"
        ],
    )
    .replace(/ー/gu, "");
}

export function extractStationSearchText(transcription: string): string {
  return normalizeKana(
    transcription
      .replace(
        /(?:次|つぎ)は|まもなく|こちらは|到着|発車|です|でございます|駅/gu,
        "",
      )
      .replace(/[、。,.!?！？「」『』（）()]/gu, ""),
  );
}
