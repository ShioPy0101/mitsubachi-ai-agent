import { normalizeKana, normalizeStationName } from "./normalization";

export type StationImportRow = {
  name: string;
  kana: string | null;
  kanaSource: string | null;
  operatorName: string | null;
  lineName: string | null;
  prefecture: string | null;
  prevStation: string | null;
  nextStation: string | null;
  longitude: number | null;
  latitude: number | null;
  postal: string | null;
};

function parseCsvRecords(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      record.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      record.push(field);
      if (record.some((value) => value.length > 0)) records.push(record);
      record = [];
      field = "";
    } else if (character !== undefined) {
      field += character;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

const nullable = (value: string | undefined): string | null => (value === undefined || value === "" ? null : value);
const numeric = (value: string | undefined): number | null => {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function parseStationsCsv(csv: string): StationImportRow[] {
  const records = parseCsvRecords(csv.replace(/^\uFEFF/u, ""));
  const [header, ...rows] = records;
  const expected = ["name", "kana", "kana_source", "operator_name", "line_name", "prefecture", "prev_station", "next_station", "longitude", "latitude", "postal"];
  if (header === undefined || header.join(",") !== expected.join(",")) throw new Error("Unexpected stations.csv header");
  return rows.map((row, index) => {
    const name = row[0];
    if (name === undefined || name.length === 0) throw new Error(`Missing station name at CSV row ${index + 2}`);
    return {
      name,
      kana: nullable(row[1]),
      kanaSource: nullable(row[2]),
      operatorName: nullable(row[3]),
      lineName: nullable(row[4]),
      prefecture: nullable(row[5]),
      prevStation: nullable(row[6]),
      nextStation: nullable(row[7]),
      longitude: numeric(row[8]),
      latitude: numeric(row[9]),
      postal: nullable(row[10]),
    };
  });
}

const sqlString = (value: string | null): string => (value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`);
const sqlNumber = (value: number | null): string => (value === null ? "NULL" : String(value));

export function generateStationsSql(rows: readonly StationImportRow[]): string {
  const statements = rows.map((row) => {
    const normalizedKana = row.kana === null ? null : normalizeKana(row.kana);
    const values = [
      sqlString(row.name), sqlString(row.kana), sqlString(row.kanaSource), sqlString(row.operatorName),
      sqlString(row.lineName), sqlString(row.prefecture), sqlString(row.prevStation), sqlString(row.nextStation),
      sqlNumber(row.longitude), sqlNumber(row.latitude), sqlString(row.postal),
      sqlString(normalizeStationName(row.name)), sqlString(normalizedKana),
    ].join(", ");
    return `INSERT INTO stations (name, kana, kana_source, operator_name, line_name, prefecture, prev_station, next_station, longitude, latitude, postal, normalized_name, normalized_kana) VALUES (${values}) ON CONFLICT DO UPDATE SET kana=excluded.kana, kana_source=excluded.kana_source, prefecture=excluded.prefecture, prev_station=excluded.prev_station, next_station=excluded.next_station, longitude=excluded.longitude, latitude=excluded.latitude, postal=excluded.postal, normalized_name=excluded.normalized_name, normalized_kana=excluded.normalized_kana;`;
  });
  return ["BEGIN TRANSACTION;", ...statements, "COMMIT;", ""].join("\n");
}
