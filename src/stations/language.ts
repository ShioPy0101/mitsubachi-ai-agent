import type { Station } from "./types";
const romanizations: Record<string, string> = {
  あ: "a",
  い: "i",
  う: "u",
  え: "e",
  お: "o",
  か: "ka",
  き: "ki",
  く: "ku",
  け: "ke",
  こ: "ko",
  さ: "sa",
  し: "shi",
  す: "su",
  せ: "se",
  そ: "so",
  た: "ta",
  ち: "chi",
  つ: "tsu",
  て: "te",
  と: "to",
  な: "na",
  に: "ni",
  ぬ: "nu",
  ね: "ne",
  の: "no",
  は: "ha",
  ひ: "hi",
  ふ: "fu",
  へ: "he",
  ほ: "ho",
  ま: "ma",
  み: "mi",
  む: "mu",
  め: "me",
  も: "mo",
  や: "ya",
  ゆ: "yu",
  よ: "yo",
  ら: "ra",
  り: "ri",
  る: "ru",
  れ: "re",
  ろ: "ro",
  わ: "wa",
  を: "o",
  ん: "n",
  が: "ga",
  ぎ: "gi",
  ぐ: "gu",
  げ: "ge",
  ご: "go",
  ざ: "za",
  じ: "ji",
  ず: "zu",
  ぜ: "ze",
  ぞ: "zo",
  だ: "da",
  ぢ: "ji",
  づ: "zu",
  で: "de",
  ど: "do",
  ば: "ba",
  び: "bi",
  ぶ: "bu",
  べ: "be",
  ぼ: "bo",
  ぱ: "pa",
  ぴ: "pi",
  ぷ: "pu",
  ぺ: "pe",
  ぽ: "po",
  きゃ: "kya",
  きゅ: "kyu",
  きょ: "kyo",
  しゃ: "sha",
  しゅ: "shu",
  しょ: "sho",
  ちゃ: "cha",
  ちゅ: "chu",
  ちょ: "cho",
  にゃ: "nya",
  にゅ: "nyu",
  にょ: "nyo",
  ひゃ: "hya",
  ひゅ: "hyu",
  ひょ: "hyo",
  みゃ: "mya",
  みゅ: "myu",
  みょ: "myo",
  りゃ: "rya",
  りゅ: "ryu",
  りょ: "ryo",
  ぎゃ: "gya",
  ぎゅ: "gyu",
  ぎょ: "gyo",
  じゃ: "ja",
  じゅ: "ju",
  じょ: "jo",
};
const aliases: Record<string, string> = {
  和倉温泉: "Wakura Onsen",
  東京: "Tokyo",
  京都: "Kyoto",
  大阪: "Osaka",
  新大阪: "Shin-Osaka",
  伊勢市: "Ise-shi",
  野洲: "Yasu",
};
export function romanizeKana(kana: string): string {
  const text = kana
    .normalize("NFKC")
    .replace(/[\u30a1-\u30f6]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0x60),
    );
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "っ") {
      result +=
        (romanizations[text.slice(i + 1, i + 3)] ??
          romanizations[text[i + 1]!] ??
          "")[0] ?? "";
      continue;
    }
    const pair = romanizations[text.slice(i, i + 2)];
    if (pair) {
      result += pair;
      i++;
    } else result += romanizations[text[i]!] ?? text[i];
  }
  return result;
}
export function stationEnglishName(station: Station): string | null {
  if (station.englishName) return station.englishName;
  if (aliases[station.name]) return aliases[station.name]!;
  if (!station.kana) return null;
  const name = romanizeKana(station.kana);
  if (!/^[a-z]+$/i.test(name)) return null;
  const words =
    station.name.endsWith("温泉") && name.endsWith("onsen")
      ? [name.slice(0, -5), "onsen"]
      : [name];
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}
export function englishStationReading(text: string): string | null {
  if (!/^[a-z\s-]+$/i.test(text)) return null;
  let rest = text.toLowerCase().replace(/[\s-]/g, ""),
    result = "";
  const reverse = Object.entries(romanizations).sort(
    (a, b) => b[1].length - a[1].length,
  );
  while (rest) {
    const item = reverse.find(([, r]) => rest.startsWith(r));
    if (!item) return null;
    result += item[0];
    rest = rest.slice(item[1].length);
  }
  return result;
}
