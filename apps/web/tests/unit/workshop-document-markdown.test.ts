import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { convertWorkshopDocumentToMarkdown } from "@/lib/workshops/document-markdown";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

function pdfWithText(text: string): Buffer {
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
	];
	let body = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(body));
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1))
		body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return Buffer.from(body);
}

describe("Workshop document Markdown conversion", () => {
	const roots: string[] = [];
	async function fixture(name: string, contents: Buffer | string) {
		const runDir = await mkdtemp(join(tmpdir(), "zhiyu-doc-markdown-"));
		roots.push(runDir);
		await mkdir(join(runDir, "inputs"));
		const inputPath = join(runDir, "inputs", name);
		await writeFile(inputPath, contents);
		return { runDir, inputPath };
	}
	afterEach(async () => {
		for (const root of roots.splice(0)) {
			const target = resolve(root);
			if (
				dirname(target) !== resolve(tmpdir()) ||
				!basename(target).startsWith("zhiyu-doc-markdown-")
			) {
				throw new Error("Unexpected test cleanup path");
			}
			await rm(target, { recursive: true, force: true });
		}
	});

	it("writes reproducible Markdown chunks with source and chunk hashes", async () => {
		const source = await fixture(
			"guide.md",
			`# Guide\n\n## Section A\n\n${"Useful paragraph. ".repeat(200)}\n\n## Section B\n\nEnd.`,
		);
		const first = await convertWorkshopDocumentToMarkdown(source);
		const second = await convertWorkshopDocumentToMarkdown(source);
		expect(second).toEqual(first);
		expect(first.chunkCount).toBeGreaterThan(1);
		const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
		expect(manifest.source.sha256).toBe(first.source.sha256);
		expect(manifest.chunks).toHaveLength(first.chunkCount);
		for (const chunk of first.chunks) {
			const markdown = await readFile(chunk.path, "utf8");
			expect(markdown).toContain("Guide");
			expect(createHash("sha256").update(markdown).digest("hex")).toBe(
				chunk.sha256,
			);
		}
		expect(await readFile(source.inputPath, "utf8")).toContain(
			"Useful paragraph.",
		);
	});

	it("converts HTML tables and CSV fields into Markdown tables", async () => {
		const html = await fixture(
			"page.html",
			"<h1>Report</h1><script>secret()</script><table><tr><th>City</th><th>Count</th></tr><tr><td>Xi'an</td><td>2</td></tr></table>",
		);
		const htmlResult = await convertWorkshopDocumentToMarkdown(html);
		const htmlMarkdown = await readFile(htmlResult.documentPath, "utf8");
		expect(htmlMarkdown).toContain("| City | Count |");
		expect(htmlMarkdown).not.toContain("secret()");

		const csv = await fixture("data.csv", 'name,note\nA,"one\ntwo"\nB,three\n');
		const csvResult = await convertWorkshopDocumentToMarkdown(csv);
		const csvMarkdown = await readFile(csvResult.documentPath, "utf8");
		expect(csvMarkdown).toContain("| name | note |");
		expect(csvMarkdown).toContain("one<br>two");
	});

	it("preserves workbook sheet and slide provenance", async () => {
		const workbook = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(
			workbook,
			XLSX.utils.aoa_to_sheet([
				["item", "qty"],
				["bolt", 3],
			]),
			"Parts",
		);
		XLSX.utils.book_append_sheet(
			workbook,
			XLSX.utils.aoa_to_sheet([
				["item", "qty"],
				["nut", 4],
			]),
			"More",
		);
		const xlsx = await fixture(
			"stock.xlsx",
			XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
		);
		const xlsxResult = await convertWorkshopDocumentToMarkdown(xlsx);
		const xlsxManifest = JSON.parse(
			await readFile(xlsxResult.manifestPath, "utf8"),
		);
		expect(await readFile(xlsxResult.documentPath, "utf8")).toContain(
			"## Sheet: Parts",
		);
		expect(
			xlsxManifest.chunks.some(
				(chunk: { location: { sheet?: string } }) =>
					chunk.location.sheet === "Parts",
			),
		).toBe(true);

		const zip = new JSZip();
		zip.file(
			"ppt/slides/slide1.xml",
			'<p:sld xmlns:p="p" xmlns:a="a"><p:sp><p:txBody><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:txBody></p:sp></p:sld>',
		);
		zip.file(
			"ppt/slides/slide2.xml",
			'<p:sld xmlns:p="p" xmlns:a="a"><p:sp><p:txBody><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:txBody></p:sp></p:sld>',
		);
		const pptx = await fixture(
			"deck.pptx",
			await zip.generateAsync({ type: "nodebuffer" }),
		);
		const pptxResult = await convertWorkshopDocumentToMarkdown(pptx);
		const pptxMarkdown = await readFile(pptxResult.documentPath, "utf8");
		expect(pptxMarkdown).toContain("## Slide 1");
		expect(pptxMarkdown).toContain("First slide");
		expect(pptxMarkdown).toContain("## Slide 2");
	});

	it("reads legacy XLS workbooks without treating binary bytes as text", async () => {
		const workbook = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(
			workbook,
			XLSX.utils.aoa_to_sheet([
				["part", "count"],
				["washer", 7],
			]),
			"Inventory",
		);
		const source = await fixture(
			"inventory.xls",
			XLSX.write(workbook, { type: "buffer", bookType: "biff8" }),
		);
		const result = await convertWorkshopDocumentToMarkdown(source);
		const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
		expect(await readFile(result.documentPath, "utf8")).toContain(
			"| washer | 7 |",
		);
		expect(manifest.source.format).toBe(".xls");
		expect(manifest.chunks[0].location.sheet).toBe("Inventory");
	});

	it("converts OpenDocument text, spreadsheets, and slides with location metadata", async () => {
		const odf = async (name: string, type: string, body: string) => {
			const zip = new JSZip();
			zip.file("mimetype", `application/vnd.oasis.opendocument.${type}`, {
				compression: "STORE",
			});
			zip.file(
				"META-INF/manifest.xml",
				`<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.${type}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
			);
			zip.file(
				"content.xml",
				`<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body>${body}</office:body></office:document-content>`,
			);
			return fixture(name, await zip.generateAsync({ type: "nodebuffer" }));
		};
		const odt = await odf(
			"memo.odt",
			"text",
			'<office:text><text:h text:outline-level="1">Quality report</text:h><text:p>Batch <text:span>passed</text:span>.</text:p><text:list><text:list-item><text:p>Keep this item</text:p></text:list-item></text:list></office:text>',
		);
		const odtResult = await convertWorkshopDocumentToMarkdown(odt);
		const odtMarkdown = await readFile(odtResult.documentPath, "utf8");
		expect(odtMarkdown).toContain("# Quality report");
		expect(odtMarkdown).toContain("Batch passed.");
		expect(odtMarkdown).toContain("- Keep this item");

		const ods = await odf(
			"stock.ods",
			"spreadsheet",
			'<office:spreadsheet><table:table table:name="Materials"><table:table-row><table:table-cell><text:p>part</text:p></table:table-cell><table:table-cell><text:p>qty</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>bolt</text:p></table:table-cell><table:table-cell><text:p>3</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>',
		);
		const odsResult = await convertWorkshopDocumentToMarkdown(ods);
		expect(await readFile(odsResult.documentPath, "utf8")).toContain(
			"| bolt | 3 |",
		);
		expect(
			JSON.parse(await readFile(odsResult.manifestPath, "utf8")).chunks[0]
				.location.sheet,
		).toBe("Materials");

		const odp = await odf(
			"deck.odp",
			"presentation",
			'<office:presentation><draw:page draw:name="First"><text:p>Opening slide</text:p></draw:page><draw:page draw:name="Second"><text:p>Final slide</text:p></draw:page></office:presentation>',
		);
		const odpResult = await convertWorkshopDocumentToMarkdown(odp);
		const odpMarkdown = await readFile(odpResult.documentPath, "utf8");
		expect(odpMarkdown).toContain("Opening slide");
		expect(odpMarkdown).toContain("## Slide 2");
		expect(
			JSON.parse(await readFile(odpResult.manifestPath, "utf8")).chunks.some(
				(chunk: { location: { slide?: number } }) => chunk.location.slide === 2,
			),
		).toBe(true);
	});

	it("converts EPUB spine chapters in reading order and keeps chapter provenance", async () => {
		const zip = new JSZip();
		zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
		zip.file(
			"META-INF/container.xml",
			'<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
		);
		zip.file(
			"OEBPS/book.opf",
			'<?xml version="1.0"?><package version="3.0" unique-identifier="id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:test:manual</dc:identifier><dc:title>Manual</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="a" href="chapters/one.xhtml" media-type="application/xhtml+xml"/><item id="b" href="chapters/two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
		);
		zip.file(
			"OEBPS/nav.xhtml",
			'<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li>Contents</li></ol></nav></body></html>',
		);
		zip.file(
			"OEBPS/chapters/one.xhtml",
			'<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>First file</h1><p>Read second.</p></body></html>',
		);
		zip.file(
			"OEBPS/chapters/two.xhtml",
			'<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Second file</h1><p>Read first.</p></body></html>',
		);
		const source = await fixture(
			"manual.epub",
			await zip.generateAsync({ type: "nodebuffer" }),
		);
		const result = await convertWorkshopDocumentToMarkdown(source);
		const markdown = await readFile(result.documentPath, "utf8");
		expect(markdown.indexOf("Read first.")).toBeLessThan(
			markdown.indexOf("Read second."),
		);
		expect(markdown).toContain("## Chapter 1");
		expect(
			JSON.parse(await readFile(result.manifestPath, "utf8")).chunks[0].location
				.chapter,
		).toBe(1);
	});

	it("converts XHTML, YAML, and XML structured text", async () => {
		const xhtml = await fixture(
			"note.xhtml",
			'<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Memo</h1><p>Useful note.</p></body></html>',
		);
		expect(
			await readFile(
				(await convertWorkshopDocumentToMarkdown(xhtml)).documentPath,
				"utf8",
			),
		).toContain("Useful note.");
		const yaml = await fixture(
			"record.yaml",
			"customer:\n  name: Ada\n  tickets:\n    - 123\n",
		);
		expect(
			await readFile(
				(await convertWorkshopDocumentToMarkdown(yaml)).documentPath,
				"utf8",
			),
		).toContain("customer.name");
		const yml = await fixture("record.yml", "status: ready\n");
		expect(
			await readFile(
				(await convertWorkshopDocumentToMarkdown(yml)).documentPath,
				"utf8",
			),
		).toContain("status");
		const xml = await fixture(
			"record.xml",
			"<customer><name>Ada</name><ticket>123</ticket></customer>",
		);
		expect(
			await readFile(
				(await convertWorkshopDocumentToMarkdown(xml)).documentPath,
				"utf8",
			),
		).toContain("customer.name");
	});

	it("decodes BOM UTF-16 and GB18030 text with visible encoding provenance", async () => {
		const text = "\u4f60\u597d";
		const utf16le = await fixture(
			"little.txt",
			Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
		);
		const littleResult = await convertWorkshopDocumentToMarkdown(utf16le);
		expect(await readFile(littleResult.documentPath, "utf8")).toContain(text);
		expect(
			JSON.parse(await readFile(littleResult.manifestPath, "utf8")).conversion
				.warnings,
		).toContain("Source text decoded as UTF-16LE from BOM");

		const beBytes = Buffer.from(text, "utf16le");
		for (let index = 0; index < beBytes.length; index += 2)
			[beBytes[index], beBytes[index + 1]] = [
				beBytes[index + 1],
				beBytes[index],
			];
		const utf16be = await fixture(
			"big.txt",
			Buffer.concat([Buffer.from([0xfe, 0xff]), beBytes]),
		);
		const bigResult = await convertWorkshopDocumentToMarkdown(utf16be);
		expect(await readFile(bigResult.documentPath, "utf8")).toContain(text);
		expect(bigResult.warnings).toContain(
			"Source text decoded as UTF-16BE from BOM",
		);

		const gb18030 = await fixture(
			"legacy.txt",
			Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),
		);
		const gbResult = await convertWorkshopDocumentToMarkdown(gb18030);
		expect(await readFile(gbResult.documentPath, "utf8")).toContain(text);
		expect(
			JSON.parse(await readFile(gbResult.manifestPath, "utf8")).conversion
				.warnings,
		).toContain("Source text decoded as GB18030 after UTF-8 validation failed");

		const invalid = await fixture("invalid.txt", Buffer.from([0xff]));
		await expect(convertWorkshopDocumentToMarkdown(invalid)).rejects.toThrow(
			"not valid UTF-8 or GB18030",
		);
	});

	it("splits long table cells into readable chunks and rejects impossible headers", async () => {
		const longCell = "content".repeat(800);
		const source = await fixture(
			"large.csv",
			`name,description\nA,${longCell}\n`,
		);
		const result = await convertWorkshopDocumentToMarkdown(source);
		expect(await readFile(result.documentPath, "utf8")).toContain(longCell);
		expect(result.chunkCount).toBeGreaterThan(2);
		for (const chunk of result.chunks) {
			const markdown = await readFile(chunk.path, "utf8");
			expect(markdown.length).toBeLessThanOrEqual(1_800);
		}
		expect(
			(
				await Promise.all(
					result.chunks.map((chunk) => readFile(chunk.path, "utf8")),
				)
			).join("\n"),
		).toContain("**Table row 2**");

		const hugeHeader = await fixture(
			"huge-header.csv",
			`${"h".repeat(1_500)},value\nA,1\n`,
		);
		await expect(convertWorkshopDocumentToMarkdown(hugeHeader)).rejects.toThrow(
			"table header exceeds the chunk limit",
		);
	});

	it("converts DOCX headings and paragraphs into Markdown", async () => {
		const zip = new JSZip();
		zip.file(
			"[Content_Types].xml",
			'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		);
		zip.file(
			"_rels/.rels",
			'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
		);
		zip.file(
			"word/document.xml",
			'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Manual</w:t></w:r></w:p><w:p><w:r><w:t>Clean this text.</w:t></w:r></w:p></w:body></w:document>',
		);
		const docx = await fixture(
			"manual.docx",
			await zip.generateAsync({ type: "nodebuffer" }),
		);
		const result = await convertWorkshopDocumentToMarkdown(docx);
		const markdown = await readFile(result.documentPath, "utf8");
		expect(markdown).toContain("# Manual");
		expect(markdown).toContain("Clean this text.");
	});

	it("extracts PDF text and rejects image-only or empty documents", async () => {
		const pdf = await fixture("page.pdf", pdfWithText("Visible PDF text"));
		const result = await convertWorkshopDocumentToMarkdown(pdf);
		expect(await readFile(result.documentPath, "utf8")).toContain(
			"Visible PDF text",
		);
		expect(
			JSON.parse(await readFile(result.manifestPath, "utf8")).chunks[0].location
				.page,
		).toBe(1);

		const imageOnly = await fixture("scanned.pdf", pdfWithText(""));
		await expect(convertWorkshopDocumentToMarkdown(imageOnly)).rejects.toThrow(
			"require OCR",
		);
		const empty = await fixture("empty.txt", "  \n  ");
		await expect(convertWorkshopDocumentToMarkdown(empty)).rejects.toThrow(
			"no extractable text",
		);
		const blankTable = await fixture("blank.csv", ",\n");
		await expect(convertWorkshopDocumentToMarkdown(blankTable)).rejects.toThrow(
			"no extractable text",
		);
	});

	it("rejects unsupported sources and paths outside the staged input and output areas", async () => {
		const unknown = await fixture("legacy.bin", Buffer.from([0, 1, 2]));
		await expect(convertWorkshopDocumentToMarkdown(unknown)).rejects.toThrow(
			"Unsupported document format",
		);
		const source = await fixture("note.txt", "Useful data");
		await expect(
			convertWorkshopDocumentToMarkdown({
				runDir: source.runDir,
				inputPath: join(source.runDir, "other.txt"),
			}),
		).rejects.toThrow();
		await expect(
			convertWorkshopDocumentToMarkdown({
				...source,
				outputDir: join(source.runDir, "inputs", "bad"),
			}),
		).rejects.toThrow("outputs directory");
	});

	it("rejects corrupt and oversized ZIP documents before writing artifacts", async () => {
		const corrupt = await fixture(
			"broken.epub",
			Buffer.from("not a ZIP archive"),
		);
		await expect(convertWorkshopDocumentToMarkdown(corrupt)).rejects.toThrow(
			"encrypted or corrupt",
		);
		const bomb = new JSZip();
		bomb.file("content.xml", "<office:document-content/>");
		bomb.file("large.bin", Buffer.alloc(25 * 1024 * 1024 + 1), {
			compression: "DEFLATE",
		});
		const oversizedBytes = await bomb.generateAsync({ type: "nodebuffer" });
		for (const format of ["odt", "docx", "pptx", "xlsx"]) {
			const oversized = await fixture(`oversized.${format}`, oversizedBytes);
			await expect(
				convertWorkshopDocumentToMarkdown(oversized),
			).rejects.toThrow("entry exceeds 25 MiB");
			await expect(
				readFile(join(oversized.runDir, "outputs", "manifest.json")),
			).rejects.toThrow();
		}
		const centralHeader = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
		const forged = Buffer.from(oversizedBytes);
		let cursor = forged.indexOf(centralHeader);
		while (cursor >= 0) {
			const nameLength = forged.readUInt16LE(cursor + 28);
			const name = forged.toString(
				"utf8",
				cursor + 46,
				cursor + 46 + nameLength,
			);
			if (name === "large.bin") break;
			cursor = forged.indexOf(centralHeader, cursor + 4);
		}
		expect(cursor).toBeGreaterThan(0);
		forged.writeUInt32LE(1, cursor + 24);
		const forgedSource = await fixture("forged.odt", forged);
		await expect(
			convertWorkshopDocumentToMarkdown(forgedSource),
		).rejects.toThrow("expands beyond its limit");

		const crcZip = new JSZip();
		crcZip.file("content.xml", "<office:document-content/>");
		const badCrc = Buffer.from(
			await crcZip.generateAsync({ type: "nodebuffer" }),
		);
		const crcHeader = badCrc.indexOf(centralHeader);
		expect(crcHeader).toBeGreaterThan(0);
		badCrc.writeUInt32LE(0, crcHeader + 16);
		const crcSource = await fixture("bad-crc.odt", badCrc);
		await expect(convertWorkshopDocumentToMarkdown(crcSource)).rejects.toThrow(
			"encrypted or corrupt",
		);
	});

	it("keeps identical source bytes from distinct Work sources separate", async () => {
		const source = await fixture("staged-note.txt", "Useful data");
		const first = await convertWorkshopDocumentToMarkdown({
			...source,
			sourceId: "source-a",
			originalName: "note.txt",
		});
		const second = await convertWorkshopDocumentToMarkdown({
			...source,
			sourceId: "source-b",
			originalName: "note.txt",
		});
		expect(first.outputDir).not.toBe(second.outputDir);
		expect(first.source.sha256).toBe(second.source.sha256);
		expect(
			JSON.parse(await readFile(first.manifestPath, "utf8")).source.sourceId,
		).toBe("source-a");
		expect(
			await convertWorkshopDocumentToMarkdown({
				...source,
				sourceId: "source-a",
				originalName: "note.txt",
			}),
		).toEqual(first);
	});
});
