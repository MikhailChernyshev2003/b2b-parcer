import * as cheerio from "cheerio";
import JSZip from "jszip";

/**
 * Plain text of an .xlsx/.xlsm workbook: one line per row, cells joined with
 * " | ", a "## <sheet name>" header per sheet. Enough for keyword matching;
 * formatting and formulas are ignored (cached formula results are kept).
 */
export async function extractXlsxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (p: string) => (await zip.file(p)?.async("string")) ?? "";

  const shared: string[] = [];
  const sst = cheerio.load(await read("xl/sharedStrings.xml"), { xml: true });
  // A shared string may consist of several rich-text runs (<r><t>…</t></r>).
  sst("si").each((_, si) => {
    shared.push(sst(si).find("t").map((__, t) => sst(t).text()).get().join(""));
  });

  // Sheet names in workbook order, resolved to their part paths via the rels.
  const wb = cheerio.load(await read("xl/workbook.xml"), { xml: true });
  const rels = cheerio.load(await read("xl/_rels/workbook.xml.rels"), { xml: true });
  const target = new Map<string, string>();
  rels("Relationship").each((_, r) => {
    const t = rels(r).attr("Target") ?? "";
    target.set(rels(r).attr("Id") ?? "", t.startsWith("/") ? t.slice(1) : `xl/${t}`);
  });
  const sheets = wb("sheet")
    .map((_, s) => ({ name: wb(s).attr("name") ?? "", path: target.get(wb(s).attr("r:id") ?? "") ?? "" }))
    .get()
    .filter((s) => s.path);

  const out: string[] = [];
  for (const sheet of sheets) {
    const ws = cheerio.load(await read(sheet.path), { xml: true });
    const lines: string[] = [];
    ws("sheetData row").each((_, row) => {
      const cells: string[] = [];
      ws(row)
        .children("c")
        .each((__, c) => {
          const cell = ws(c);
          const type = cell.attr("t");
          const v = cell.children("v").text();
          let text: string;
          if (type === "s") text = shared[Number(v)] ?? "";
          else if (type === "inlineStr") text = cell.find("is t").map((___, t) => ws(t).text()).get().join("");
          else if (type === "b") text = v === "1" ? "ИСТИНА" : "ЛОЖЬ";
          else text = v;
          text = text.replace(/\s+/g, " ").trim();
          if (text) cells.push(text);
        });
      if (cells.length) lines.push(cells.join(" | "));
    });
    if (lines.length) out.push(`## ${sheet.name}\n${lines.join("\n")}`);
  }
  return out.join("\n\n");
}
