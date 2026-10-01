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

export type StationLinePosition = {
  lineId: string;
  station: StationImportRow;
  seq: number;
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

const nullable = (value: string | undefined): string | null =>
  value === undefined || value === "" ? null : value;
const numeric = (value: string | undefined): number | null => {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function parseStationsCsv(csv: string): StationImportRow[] {
  const records = parseCsvRecords(csv.replace(/^\uFEFF/u, ""));
  const [header, ...rows] = records;
  const expected = [
    "name",
    "kana",
    "kana_source",
    "operator_name",
    "line_name",
    "prefecture",
    "prev_station",
    "next_station",
    "longitude",
    "latitude",
    "postal",
  ];
  if (header === undefined || header.join(",") !== expected.join(","))
    throw new Error("Unexpected stations.csv header");
  return rows.map((row, index) => {
    const name = row[0];
    if (name === undefined || name.length === 0)
      throw new Error(`Missing station name at CSV row ${index + 2}`);
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

function edgeKey(left: string, right: string): string {
  return [left, right].sort((a, b) => a.localeCompare(b, "ja")).join("\u0000");
}

export function buildStationLinePositions(
  rows: readonly StationImportRow[],
): StationLinePosition[] {
  const groups = new Map<string, StationImportRow[]>();
  for (const row of rows) {
    if (row.lineName === null) continue;
    const groupKey = JSON.stringify([row.operatorName ?? "", row.lineName]);
    const group = groups.get(groupKey) ?? [];
    group.push(row);
    groups.set(groupKey, group);
  }

  const positions: StationLinePosition[] = [];
  for (const [groupKey, group] of [...groups].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const byName = new Map(group.map((row) => [row.name, row]));
    const neighbors = new Map(
      group.map((row) => [row.name, new Set<string>()]),
    );
    for (const row of group) {
      for (const neighborName of [row.prevStation, row.nextStation]) {
        if (neighborName === null || !byName.has(neighborName)) continue;
        neighbors.get(row.name)?.add(neighborName);
        neighbors.get(neighborName)?.add(row.name);
      }
    }

    const visitedEdges = new Set<string>();
    const segments: string[][] = [];
    const boundaries = [...byName.keys()]
      .filter((name) => (neighbors.get(name)?.size ?? 0) !== 2)
      .sort((left, right) => left.localeCompare(right, "ja"));

    for (const boundary of boundaries) {
      const adjacent = [...(neighbors.get(boundary) ?? [])].sort(
        (left, right) => left.localeCompare(right, "ja"),
      );
      if (adjacent.length === 0) segments.push([boundary]);
      for (const firstNeighbor of adjacent) {
        if (visitedEdges.has(edgeKey(boundary, firstNeighbor))) continue;
        const segment = [boundary];
        let previous = boundary;
        let current = firstNeighbor;
        visitedEdges.add(edgeKey(previous, current));
        while (true) {
          segment.push(current);
          if ((neighbors.get(current)?.size ?? 0) !== 2) break;
          const next = [...(neighbors.get(current) ?? [])]
            .filter((name) => name !== previous)
            .sort((left, right) => left.localeCompare(right, "ja"))[0];
          if (next === undefined || visitedEdges.has(edgeKey(current, next)))
            break;
          previous = current;
          current = next;
          visitedEdges.add(edgeKey(previous, current));
        }
        segments.push(segment);
      }
    }

    // A component with no boundary is a loop. Break it at a deterministic station.
    for (const start of [...byName.keys()].sort((left, right) =>
      left.localeCompare(right, "ja"),
    )) {
      const firstNeighbor = [...(neighbors.get(start) ?? [])]
        .filter((name) => !visitedEdges.has(edgeKey(start, name)))
        .sort((left, right) => left.localeCompare(right, "ja"))[0];
      if (firstNeighbor === undefined) continue;
      const segment = [start];
      let previous = start;
      let current = firstNeighbor;
      visitedEdges.add(edgeKey(previous, current));
      while (current !== start) {
        segment.push(current);
        const next = [...(neighbors.get(current) ?? [])]
          .filter(
            (name) =>
              name !== previous && !visitedEdges.has(edgeKey(current, name)),
          )
          .sort((left, right) => left.localeCompare(right, "ja"))[0];
        if (next === undefined) break;
        previous = current;
        current = next;
        visitedEdges.add(edgeKey(previous, current));
      }
      segments.push(segment);
    }

    // Split closed branch paths at the repeated boundary, retaining the closing
    // edge as a separate ordered path. D1's unique station/seq keys cannot store
    // the same station twice in one segment.
    for (let i = 0; i < segments.length; i++) {
      const path = segments[i]!;
      if (path.length > 2 && path[0] === path.at(-1))
        segments[i] = path.slice(0, -1);
    }
    const coveredEdges = new Set(
      segments.flatMap((path) =>
        path.slice(1).map((name, i) => edgeKey(path[i]!, name)),
      ),
    );
    for (const [name, adjacent] of neighbors)
      for (const neighbor of adjacent) {
        const key = edgeKey(name, neighbor);
        if (!coveredEdges.has(key)) {
          segments.push([name, neighbor]);
          coveredEdges.add(key);
        }
      }

    segments
      .sort((left, right) =>
        left.join("\u0000").localeCompare(right.join("\u0000"), "ja"),
      )
      .forEach((segment, segmentIndex) => {
        const lineId = `${groupKey}#${segmentIndex}:${segment[0] ?? ""}`;
        segment.forEach((name, seq) => {
          const station = byName.get(name);
          if (station !== undefined) positions.push({ lineId, station, seq });
        });
      });
  }
  return positions;
}
