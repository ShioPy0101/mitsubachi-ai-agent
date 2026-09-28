import { describe, expect, it, vi } from "vitest";
import { D1StationsRepository } from "../src/db/stations-repository";

describe("D1StationsRepository", () => {
  it("does not use the full transcription as a LIKE pattern", async () => {
    const all = vi.fn().mockResolvedValue({ results: [] });
    const bind = vi.fn().mockReturnValue({ all });
    const prepare = vi.fn().mockReturnValue({ bind });
    const repository = new D1StationsRepository({ prepare } as unknown as D1Database);
    const searchText = "2番線に折り返し中本行が到着します";

    await expect(repository.findCandidatePool(searchText, {}, 100)).resolves.toEqual([]);

    const sql = prepare.mock.calls[0]?.[0] as string;
    expect(sql).not.toContain("normalized_name LIKE");
    expect(bind).toHaveBeenCalledWith(
      searchText,
      searchText,
      searchText.slice(0, 2),
      searchText,
      searchText,
      null, null,
      null, null,
      null, null, null,
      null, null, null,
      searchText,
      searchText,
      null,
      searchText,
      100,
    );
  });
});
