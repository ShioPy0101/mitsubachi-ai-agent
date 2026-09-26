import type { Station } from "../../src/stations/types";

export const iseStations: Station[] = [
  {
    id: 1, name: "伊勢市", kana: "いせし", kanaSource: "pykakasi", operatorName: null,
    lineName: "JR参宮線", prefecture: "三重県", prevStation: "山田上口", nextStation: "五十鈴ヶ丘",
    longitude: 136.709661, latitude: 34.49126, postal: "5160073",
  },
  {
    id: 2, name: "五十鈴ヶ丘", kana: "いすずゖおか", kanaSource: "pykakasi", operatorName: null,
    lineName: "JR参宮線", prefecture: "三重県", prevStation: "伊勢市", nextStation: "二見浦",
    longitude: 136.739797, latitude: 34.495884, postal: "5160018",
  },
  {
    id: 3, name: "二見浦", kana: "ふたみがうら", kanaSource: "pykakasi", operatorName: null,
    lineName: "JR参宮線", prefecture: "三重県", prevStation: "五十鈴ヶ丘", nextStation: "松下",
    longitude: 136.77713, latitude: 34.503753, postal: "5190603",
  },
];
