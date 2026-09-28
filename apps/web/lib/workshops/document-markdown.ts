import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
} from "node:path";
import type { Readable } from "node:stream";
import { crc32 } from "node:zlib";

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_CHUNK_CHARS = 1_800;
const CONVERTER_VERSION = 1;
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 100 * 1024 * 1024;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_HEADER = 0x06054b50;

const SUPPORTED_FORMATS = new Set([
	".md",
	".txt",
	".html",
	".htm",
	".xhtml",
	".pdf",
	".docx",
	".pptx",
	".xlsx",
	".xls",
	".ods",
	".odt",
	".odp",
	".epub",
	".csv",
	".tsv",
	".json",
	".yaml",
	".yml",
	".xml",
]);

export interface WorkshopDocumentMarkdownResult {
	source: {
		path: string;
		sha256: string;
		format: string;
		sourceId?: string;
		originalName?: string;
	};
	outputDir: string;
	documentPath: string;
	manifestPath: string;
	chunkCount: number;
	chunks: Array<{ path: string; sha256: string; index: number }>;
	warnings: string[];
}

interface MarkdownSegment {
	content: string;
	headingPath: string[];
	location: { page?: number; slide?: number; sheet?: string; chapter?: number };
}

function sha256(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
	const part = relative(root, candidate);
	return (
		part === "" ||
		(part !== ".." &&
			!part.startsWith("../") &&
			!part.startsWith("..\\") &&
			!isAbsolute(part))
	);
}

async function nearestExisting(candidate: string): Promise<string> {
	try {
		return await realpath(candidate);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(candidate);
		if (parent === candidate) throw error;
		return join(await nearestExisting(parent), basename(candidate));
	}
}

function decodeText(bytes: Buffer, warnings: string[]): string {
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		warnings.push("Source text decoded as UTF-16LE from BOM");
		return new TextDecoder("utf-16le", { fatal: true }).decode(
			bytes.subarray(2),
		);
	}
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		warnings.push("Source text decoded as UTF-16BE from BOM");
		return new TextDecoder("utf-16be", { fatal: true }).decode(
			bytes.subarray(2),
		);
	}
	try {
		return new TextDecoder("utf-8", { fatal: true })
			.decode(bytes)
			.replace(/^\uFEFF/, "");
	} catch {
		try {
			const text = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
			warnings.push(
				"Source text decoded as GB18030 after UTF-8 validation failed",
			);
			return text;
		} catch {
			throw new Error("Source text is not valid UTF-8 or GB18030");
		}
	}
}

function normalizeMarkdown(text: string): string {
	return `${text.replace(/\r\n?/g, "\n").trim()}\n`;
}

function titleFor(name: string): string {
	return (
		basename(name, extname(name))
			.replace(/[\r\n#]/g, " ")
			.trim() || "Document"
	);
}

function markdownCell(value: unknown): string {
	return String(value ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/\n/g, "<br>")
		.trim();
}

function markdownTable(rows: unknown[][]): string {
	const width = Math.max(1, ...rows.map((row) => row.length));
	const [first, ...rest] = rows;
	const header = Array.from(
		{ length: width },
		(_, column) => markdownCell(first?.[column]) || `Column ${column + 1}`,
	);
	const lines = [
		`| ${header.join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...rest.map(
			(row) =>
				`| ${Array.from({ length: width }, (_, column) => markdownCell(row[column])).join(" | ")} |`,
		),
	];
	return lines.join("\n");
}

async function htmlToMarkdown(html: string): Promise<string> {
	const { default: TurndownService } = await import("turndown");
	const converter = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
	converter.remove(["script", "style", "noscript", "iframe"]);
	converter.addRule("markdownTables", {
		filter: "table",
		replacement: (_content, node) => {
			const rows = Array.from((node as HTMLElement).querySelectorAll("tr")).map(
				(row) =>
					Array.from(row.querySelectorAll("th, td")).map(
						(cell) => cell.textContent ?? "",
					),
			);
			return rows.length ? `\n\n${markdownTable(rows)}\n\n` : "";
		},
	});
	return converter.turndown(html);
}

function renderJsonValue(
	value: unknown,
	path: string,
	depth: number,
): string[] {
	if (depth > 12) return [`- ${path}: ${JSON.stringify(value)}`];
	if (Array.isArray(value)) {
		if (value.length === 0) return [`- ${path}: []`];
		return value.flatMap((item, index) =>
			renderJsonValue(item, `${path}[${index}]`, depth + 1),
		);
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value);
		if (entries.length === 0) return [`- ${path}: {}`];
		return entries.flatMap(([key, item]) =>
			renderJsonValue(item, path ? `${path}.${key}` : key, depth + 1),
		);
	}
	return [`- **${path || "value"}**: ${JSON.stringify(value)}`];
}

function collectXmlTag(node: unknown, target: string): unknown[] {
	if (!Array.isArray(node)) return [];
	const found: unknown[] = [];
	for (const entry of node) {
		if (!entry || typeof entry !== "object") continue;
		for (const [key, value] of Object.entries(entry)) {
			if (key === target) found.push(value);
			found.push(...collectXmlTag(value, target));
		}
	}
	return found;
}

function xmlText(node: unknown): string {
	if (!Array.isArray(node)) return "";
	return node
		.flatMap((entry) => {
			if (!entry || typeof entry !== "object") return [];
			return Object.entries(entry).flatMap(([key, value]) => {
				if (key === "a:t") return collectXmlTag(value, "#text").map(String);
				return xmlText(value);
			});
		})
		.join("");
}

async function parsePptx(bytes: Buffer, warnings: string[]): Promise<string> {
	const { XMLParser } = await import("fast-xml-parser");
	const archive = await boundedArchive(bytes, "PPTX");
	const slides = Object.keys(archive.files)
		.map((path) => ({
			path,
			number: /^ppt\/slides\/slide(\d+)\.xml$/.exec(path)?.[1],
		}))
		.filter((slide): slide is { path: string; number: string } =>
			Boolean(slide.number),
		)
		.sort((a, b) => Number(a.number) - Number(b.number));
	if (slides.length === 0) throw new Error("PPTX contains no slides");
	if (slides.length > 1_000)
		throw new Error("PPTX exceeds the 1,000 slide conversion limit");
	const parser = new XMLParser({
		preserveOrder: true,
		ignoreAttributes: true,
		trimValues: false,
	});
	const parts: string[] = [];
	for (const slide of slides) {
		const slideFile = archive.file(slide.path);
		if (!slideFile) throw new Error(`Missing slide ${slide.number} in PPTX`);
		const xml = await slideFile.async("string");
		if (xml.length > 10_000_000)
			throw new Error(`Slide ${slide.number} XML is too large`);
		const paragraphs = collectXmlTag(parser.parse(xml), "a:p")
			.map((paragraph) => xmlText(paragraph).trim())
			.filter(Boolean);
		if (paragraphs.length === 0)
			warnings.push(
				`Slide ${slide.number} contains no extractable text; images require OCR`,
			);
		parts.push(`## Slide ${slide.number}\n\n${paragraphs.join("\n\n")}`);
	}
	return parts.join("\n\n");
}

async function parsePdf(bytes: Buffer, warnings: string[]): Promise<string> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const loading = pdfjs.getDocument({
		data: new Uint8Array(bytes),
		useSystemFonts: true,
		disableFontFace: true,
		isEvalSupported: false,
	});
	const pdf = await loading.promise;
	try {
		if (pdf.numPages > 1_000)
			throw new Error("PDF exceeds the 1,000 page conversion limit");
		const pages: string[] = [];
		for (let number = 1; number <= pdf.numPages; number++) {
			const page = await pdf.getPage(number);
			const content = await page.getTextContent();
			const lines: string[] = [];
			let line = "";
			let previousY: number | undefined;
			for (const item of content.items) {
				if (!("str" in item) || !item.str.trim()) continue;
				const y = item.transform?.[5];
				if (
					previousY !== undefined &&
					y !== undefined &&
					Math.abs(y - previousY) > 2 &&
					line.trim()
				) {
					lines.push(line.trim());
					line = "";
				}
				line += `${line && !/\s$/.test(line) ? " " : ""}${item.str}`;
				previousY = y;
			}
			if (line.trim()) lines.push(line.trim());
			if (lines.length === 0)
				warnings.push(
					`Page ${number} contains no extractable text; scanned pages require OCR`,
				);
			pages.push(`## Page ${number}\n\n${lines.join("\n")}`);
			page.cleanup();
		}
		return pages.join("\n\n");
	} finally {
		await pdf.destroy();
	}
}

function checkZipDirectory(bytes: Buffer, format: string): void {
	let end = -1;
	for (
		let offset = bytes.length - 22;
		offset >= Math.max(0, bytes.length - 65_557);
		offset--
	) {
		if (
			bytes.readUInt32LE(offset) === ZIP_END_HEADER &&
			offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
		) {
			end = offset;
			break;
		}
	}
	if (end < 0) throw new Error(`${format} archive is encrypted or corrupt`);
	const entries = bytes.readUInt16LE(end + 10);
	const directorySize = bytes.readUInt32LE(end + 12);
	const directoryOffset = bytes.readUInt32LE(end + 16);
	if (entries > MAX_ARCHIVE_ENTRIES)
		throw new Error(`${format} archive exceeds the 2,000 entry limit`);
	if (
		bytes.readUInt16LE(end + 4) !== 0 ||
		bytes.readUInt16LE(end + 6) !== 0 ||
		bytes.readUInt16LE(end + 8) !== entries ||
		entries === 0xffff ||
		directorySize === 0xffffffff ||
		directoryOffset === 0xffffffff ||
		directoryOffset + directorySize > end
	)
		throw new Error(
			`${format} archive uses unsupported ZIP layout or is corrupt`,
		);
	let cursor = directoryOffset;
	for (let index = 0; index < entries; index++) {
		if (
			cursor + 46 > end ||
			bytes.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER
		) {
			throw new Error(`${format} archive central directory is corrupt`);
		}
		cursor +=
			46 +
			bytes.readUInt16LE(cursor + 28) +
			bytes.readUInt16LE(cursor + 30) +
			bytes.readUInt16LE(cursor + 32);
	}
	if (cursor !== directoryOffset + directorySize)
		throw new Error(`${format} archive central directory is corrupt`);
}

async function boundedArchive(bytes: Buffer, format: string) {
	checkZipDirectory(bytes, format);
	const { default: JSZip } = await import("jszip");
	let archive: Awaited<ReturnType<typeof JSZip.loadAsync>>;
	try {
		archive = await JSZip.loadAsync(bytes);
	} catch {
		throw new Error(`${format} archive is encrypted or corrupt`);
	}
	const entries = Object.values(archive.files);
	if (entries.length > MAX_ARCHIVE_ENTRIES)
		throw new Error(`${format} archive exceeds the 2,000 entry limit`);
	let totalBytes = 0;
	for (const entry of entries) {
		if (entry.dir) continue;
		const size = (
			entry as typeof entry & { _data?: { uncompressedSize?: number } }
		)._data?.uncompressedSize;
		if (!Number.isSafeInteger(size) || size === undefined || size < 0) {
			throw new Error(`${format} archive has an invalid entry size`);
		}
		if (size > MAX_ARCHIVE_ENTRY_BYTES)
			throw new Error(`${format} archive entry exceeds 25 MiB`);
		totalBytes += size;
		if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES)
			throw new Error(`${format} archive expands beyond 100 MiB`);
	}
	// Stream every entry so forged ZIP sizes cannot bypass the expansion limit.
	let actualTotalBytes = 0;
	for (const entry of entries) {
		if (entry.dir) continue;
		const metadata = (
			entry as typeof entry & {
				_data: { uncompressedSize: number; crc32: number };
			}
		)._data;
		const stream = entry.nodeStream() as Readable;
		let actualSize = 0;
		let actualCrc = 0;
		try {
			await new Promise<void>((resolve, reject) => {
				let finished = false;
				const fail = (error: Error) => {
					if (finished) return;
					finished = true;
					stream.destroy();
					reject(error);
				};
				stream.on("data", (chunk: Buffer) => {
					if (finished) return;
					const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					actualSize += part.length;
					if (
						actualSize > MAX_ARCHIVE_ENTRY_BYTES ||
						actualTotalBytes + actualSize > MAX_ARCHIVE_TOTAL_BYTES
					) {
						fail(new Error(`${format} archive expands beyond its limit`));
						return;
					}
					actualCrc = crc32(part, actualCrc);
				});
				stream.on("error", fail);
				stream.on("end", () => {
					if (finished) return;
					finished = true;
					resolve();
				});
			});
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes("expands beyond its limit")
			)
				throw error;
			throw new Error(`${format} archive is encrypted or corrupt`);
		}
		if (
			actualSize !== metadata.uncompressedSize ||
			actualCrc !== metadata.crc32 >>> 0
		) {
			throw new Error(`${format} archive is encrypted or corrupt`);
		}
		actualTotalBytes += actualSize;
	}
	return archive;
}

function xmlElements(
	value: unknown,
	tag: string,
): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is Record<string, unknown> =>
		Boolean(entry && typeof entry === "object" && tag in entry),
	);
}

function collectXmlElements(
	value: unknown,
	tag: string,
): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const element = entry as Record<string, unknown>;
		return [
			...(tag in element ? [element] : []),
			...Object.entries(element).flatMap(([key, child]) =>
				key.startsWith(":@") ? [] : collectXmlElements(child, tag),
			),
		];
	});
}

function xmlAttribute(
	element: Record<string, unknown>,
	name: string,
): string | undefined {
	const attributes = element[":@"];
	if (!attributes || typeof attributes !== "object") return undefined;
	const value = (attributes as Record<string, unknown>)[`@_${name}`];
	return value === undefined ? undefined : String(value);
}

function odfText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map((entry) => {
			if (!entry || typeof entry !== "object") return "";
			return Object.entries(entry)
				.map(([key, child]) => {
					if (key === "#text") return String(child);
					if (key === "text:tab") return "\t";
					if (key === "text:line-break") return "\n";
					if (key === "text:s") {
						const count = Number(
							xmlAttribute(entry as Record<string, unknown>, "text:c") ?? "1",
						);
						return " ".repeat(
							Math.min(
								100,
								Number.isSafeInteger(count) && count > 0 ? count : 1,
							),
						);
					}
					if (key.startsWith(":@")) return "";
					return odfText(child);
				})
				.join("");
		})
		.join("");
}

function odfTableRows(table: unknown): unknown[][] {
	const rowElements = collectXmlElements(table, "table:table-row");
	const rows: unknown[][] = [];
	for (const row of rowElements) {
		const cells: string[] = [];
		const cellElements = (row["table:table-row"] as unknown[]).filter(
			(entry): entry is Record<string, unknown> =>
				Boolean(
					entry &&
						typeof entry === "object" &&
						("table:table-cell" in entry ||
							"table:covered-table-cell" in entry),
				),
		);
		for (const [index, cell] of cellElements.entries()) {
			const tag =
				"table:table-cell" in cell
					? "table:table-cell"
					: "table:covered-table-cell";
			const content =
				odfText(cell[tag]).trim() ||
				xmlAttribute(cell, "office:string-value") ||
				xmlAttribute(cell, "office:value") ||
				"";
			const repeat = Number(
				xmlAttribute(cell, "table:number-columns-repeated") ?? "1",
			);
			if (!Number.isSafeInteger(repeat) || repeat < 1)
				throw new Error("Invalid repeated ODF table cell count");
			if (!content && index === cellElements.length - 1) break;
			if (cells.length + repeat > 256)
				throw new Error("ODF table exceeds the 256 column conversion limit");
			cells.push(...Array.from({ length: repeat }, () => content));
		}
		const repeat = Number(
			xmlAttribute(row, "table:number-rows-repeated") ?? "1",
		);
		if (!Number.isSafeInteger(repeat) || repeat < 1)
			throw new Error("Invalid repeated ODF table row count");
		if (!cells.some(Boolean)) continue;
		if (rows.length + repeat > 5_000)
			throw new Error("ODF table exceeds the 5,000 row conversion limit");
		for (let index = 0; index < repeat; index++) rows.push(cells);
	}
	return rows;
}

function odfDocumentBlocks(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		return Object.entries(entry).flatMap(([key, child]) => {
			if (key === "text:h") {
				const level = Number(
					xmlAttribute(
						entry as Record<string, unknown>,
						"text:outline-level",
					) ?? "1",
				);
				return [
					`${"#".repeat(Math.min(6, Math.max(1, Number.isFinite(level) ? level : 1)))} ${odfText(child).trim()}`,
				];
			}
			if (key === "text:p") return [odfText(child).trim()].filter(Boolean);
			if (key === "text:list") {
				return xmlElements(child, "text:list-item")
					.map((item) => `- ${odfText(item["text:list-item"]).trim()}`)
					.filter((line) => line !== "- ");
			}
			if (key === "table:table") {
				const rows = odfTableRows(child);
				return rows.length ? [markdownTable(rows)] : [];
			}
			if (key.startsWith(":@")) return [];
			return odfDocumentBlocks(child);
		});
	});
}

function odfParagraphs(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		return Object.entries(entry).flatMap(([key, child]) => {
			if (key === "text:p" || key === "text:h")
				return [odfText(child).trim()].filter(Boolean);
			return key.startsWith(":@") ? [] : odfParagraphs(child);
		});
	});
}

async function parseOpenDocument(
	bytes: Buffer,
	format: ".odt" | ".ods" | ".odp",
	warnings: string[],
): Promise<string> {
	const { XMLParser, XMLValidator } = await import("fast-xml-parser");
	const archive = await boundedArchive(bytes, format.toUpperCase());
	const contentFile = archive.file("content.xml");
	if (!contentFile) throw new Error("OpenDocument is missing content.xml");
	const xml = await contentFile.async("string");
	if (xml.length > 20_000_000)
		throw new Error("OpenDocument content XML is too large");
	if (XMLValidator.validate(xml) !== true)
		throw new Error("OpenDocument content XML is invalid");
	const parser = new XMLParser({
		preserveOrder: true,
		ignoreAttributes: false,
		trimValues: false,
	});
	const document = parser.parse(xml);
	const body = collectXmlTag(document, "office:body")[0];
	const expected =
		format === ".odt"
			? "office:text"
			: format === ".ods"
				? "office:spreadsheet"
				: "office:presentation";
	const content = xmlElements(body, expected)[0]?.[expected];
	if (!content) throw new Error(`OpenDocument is missing ${expected}`);
	if (/<draw:image\b/i.test(xml))
		warnings.push("OpenDocument contains images; image content requires OCR");
	if (format === ".odt") return odfDocumentBlocks(content).join("\n\n");
	if (format === ".ods") {
		const sheets = xmlElements(content, "table:table");
		if (sheets.length > 1_000)
			throw new Error("ODS exceeds the 1,000 sheet conversion limit");
		return sheets
			.map((sheet, index) => {
				const name = xmlAttribute(sheet, "table:name") ?? `Sheet ${index + 1}`;
				const rows = odfTableRows(sheet["table:table"]);
				if (!rows.length) {
					warnings.push(`Sheet ${name} is empty`);
					return "";
				}
				return `## Sheet: ${name}\n\n${markdownTable(rows)}`;
			})
			.filter(Boolean)
			.join("\n\n");
	}
	const slides = xmlElements(content, "draw:page");
	if (slides.length > 1_000)
		throw new Error("ODP exceeds the 1,000 slide conversion limit");
	return slides
		.map((slide, index) => {
			const paragraphs = odfParagraphs(slide["draw:page"]);
			if (!paragraphs.length)
				warnings.push(
					`Slide ${index + 1} contains no extractable text; images require OCR`,
				);
			return `## Slide ${index + 1}\n\n${paragraphs.join("\n\n")}`;
		})
		.join("\n\n");
}

function archivePath(base: string, href: string): string {
	const path = posix.normalize(
		posix.join(posix.dirname(base), decodeURIComponent(href.split("#")[0])),
	);
	if (
		!path ||
		path === "." ||
		path === ".." ||
		path.startsWith("../") ||
		posix.isAbsolute(path)
	) {
		throw new Error("EPUB references a file outside the archive");
	}
	return path;
}

async function parseEpub(bytes: Buffer, warnings: string[]): Promise<string> {
	const { XMLParser, XMLValidator } = await import("fast-xml-parser");
	const archive = await boundedArchive(bytes, "EPUB");
	const containerFile = archive.file("META-INF/container.xml");
	if (!containerFile) throw new Error("EPUB is missing META-INF/container.xml");
	const containerXml = await containerFile.async("string");
	if (
		containerXml.length > 1_000_000 ||
		XMLValidator.validate(containerXml) !== true
	) {
		throw new Error("EPUB container XML is invalid or too large");
	}
	const parser = new XMLParser({ ignoreAttributes: false });
	const container = parser.parse(containerXml);
	const rootfile = container?.container?.rootfiles?.rootfile;
	const opfPath = (Array.isArray(rootfile) ? rootfile[0] : rootfile)?.[
		"@_full-path"
	];
	if (typeof opfPath !== "string")
		throw new Error("EPUB has no package rootfile");
	const packagePath = archivePath("root", opfPath);
	const packageFile = archive.file(packagePath);
	if (!packageFile) throw new Error("EPUB package file is missing");
	const packageXml = await packageFile.async("string");
	if (
		packageXml.length > 5_000_000 ||
		XMLValidator.validate(packageXml) !== true
	) {
		throw new Error("EPUB package XML is invalid or too large");
	}
	const opf = parser.parse(packageXml)?.package;
	const items = opf?.manifest?.item;
	const spine = opf?.spine?.itemref;
	if (!items || !spine)
		throw new Error("EPUB has no readable manifest or spine");
	const byId = new Map(
		(Array.isArray(items) ? items : [items]).map(
			(item: Record<string, string>) => [item["@_id"], item],
		),
	);
	const refs = Array.isArray(spine) ? spine : [spine];
	if (refs.length > 1_000)
		throw new Error("EPUB exceeds the 1,000 chapter conversion limit");
	const chapters: string[] = [];
	for (const [index, ref] of refs.entries()) {
		const item = byId.get(ref["@_idref"]);
		if (!item || item["@_media-type"] !== "application/xhtml+xml") {
			warnings.push(`Chapter ${index + 1} is not readable XHTML`);
			continue;
		}
		const path = archivePath(packagePath, item["@_href"]);
		const chapterFile = archive.file(path);
		if (!chapterFile) throw new Error(`EPUB chapter ${index + 1} is missing`);
		const html = await chapterFile.async("string");
		if (html.length > 10_000_000)
			throw new Error(`EPUB chapter ${index + 1} is too large`);
		if (/<img\b/i.test(html))
			warnings.push(
				`Chapter ${index + 1} contains images; image content requires OCR`,
			);
		const chapterHtml = html
			.replace(/<img\b[^>]*>/gi, "[Image omitted]")
			.replace(
				/<(\/?)h([1-6])(?=[\s>])/gi,
				(_match, slash: string, level: string) =>
					`<${slash}h${Math.min(6, Number(level) + 2)}`,
			);
		const markdown = (await htmlToMarkdown(chapterHtml)).trim();
		if (!markdown.replace(/\[Image omitted\]/g, "").trim()) {
			warnings.push(`Chapter ${index + 1} contains no extractable text`);
			continue;
		}
		chapters.push(`## Chapter ${index + 1}\n\n${markdown}`);
	}
	return chapters.join("\n\n");
}

async function parseDocument(
	bytes: Buffer,
	format: string,
	name: string,
	warnings: string[],
): Promise<string> {
	switch (format) {
		case ".md":
		case ".txt":
			return decodeText(bytes, warnings);
		case ".html":
		case ".htm":
		case ".xhtml":
			return htmlToMarkdown(decodeText(bytes, warnings));
		case ".pdf":
			return parsePdf(bytes, warnings);
		case ".docx": {
			await boundedArchive(bytes, "DOCX");
			const module = await import("mammoth");
			const mammoth = module.default ?? module;
			const result = await mammoth.convertToHtml({ buffer: bytes });
			warnings.push(
				...result.messages.map((message) => `DOCX: ${message.message}`),
			);
			if (/<img\b/i.test(result.value))
				warnings.push(
					"DOCX contains images; embedded image content requires OCR",
				);
			return htmlToMarkdown(
				result.value.replace(/<img\b[^>]*>/gi, "[Image omitted]"),
			);
		}
		case ".pptx":
			return parsePptx(bytes, warnings);
		case ".xlsx":
		case ".xls": {
			if (format === ".xlsx") await boundedArchive(bytes, "XLSX");
			const XLSX = await import("xlsx");
			const workbook = XLSX.read(bytes, {
				type: "buffer",
				cellDates: true,
				cellText: true,
			});
			const sheets = workbook.SheetNames.map((sheetName) => {
				const rows = XLSX.utils.sheet_to_json<unknown[]>(
					workbook.Sheets[sheetName],
					{
						header: 1,
						defval: "",
						raw: false,
						blankrows: false,
					},
				) as unknown[][];
				if (
					!rows.some((row) => row.some((cell) => String(cell ?? "").trim()))
				) {
					warnings.push(`Sheet ${sheetName} is empty`);
					return "";
				}
				return `## Sheet: ${sheetName}\n\n${markdownTable(rows)}`;
			}).filter(Boolean);
			return sheets.join("\n\n");
		}
		case ".odt":
		case ".ods":
		case ".odp":
			return parseOpenDocument(bytes, format, warnings);
		case ".epub":
			return parseEpub(bytes, warnings);
		case ".csv":
		case ".tsv": {
			const Papa = (await import("papaparse")).default;
			const parsed = Papa.parse<string[]>(decodeText(bytes, warnings), {
				header: false,
				delimiter: format === ".tsv" ? "\t" : ",",
				skipEmptyLines: "greedy",
			});
			if (parsed.errors.length > 0)
				throw new Error(
					`Delimited file parse failed: ${parsed.errors[0].message}`,
				);
			return parsed.data.some((row) => row.some((cell) => cell.trim()))
				? `## Table: ${name}\n\n${markdownTable(parsed.data)}`
				: "";
		}
		case ".json": {
			const value = JSON.parse(decodeText(bytes, warnings)) as unknown;
			return renderJsonValue(value, "", 0).join("\n");
		}
		case ".yaml":
		case ".yml": {
			const { parse } = await import("yaml");
			const value = parse(decodeText(bytes, warnings), {
				uniqueKeys: true,
			}) as unknown;
			return renderJsonValue(value, "", 0).join("\n");
		}
		case ".xml": {
			const { XMLParser, XMLValidator } = await import("fast-xml-parser");
			const xml = decodeText(bytes, warnings);
			if (XMLValidator.validate(xml) !== true)
				throw new Error("XML document is invalid");
			const value = new XMLParser({
				ignoreAttributes: false,
				trimValues: true,
			}).parse(xml) as unknown;
			return renderJsonValue(value, "", 0).join("\n");
		}
		default:
			throw new Error(`Unsupported document format: ${format || "(none)"}`);
	}
}

function markdownBlocks(markdown: string): string[] {
	const blocks: string[] = [];
	const lines = markdown.trim().split("\n");
	let current: string[] = [];
	let inFence = false;
	const flush = () => {
		if (current.length) blocks.push(current.join("\n").trim());
		current = [];
	};
	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		if (!inFence && /^#{1,6}\s+/.test(line)) flush();
		if (!inFence && !line.trim()) {
			flush();
			continue;
		}
		current.push(line);
	}
	flush();
	return blocks.filter(Boolean);
}

function splitLongLine(line: string, limit: number): string[] {
	if (line.length <= limit) return [line];
	const pieces: string[] = [];
	let remaining = line;
	while (remaining.length > limit) {
		const whitespace = remaining.lastIndexOf(" ", limit);
		const cut = whitespace > limit / 2 ? whitespace : limit;
		pieces.push(remaining.slice(0, cut).trimEnd());
		remaining = remaining.slice(cut).trimStart();
	}
	if (remaining) pieces.push(remaining);
	return pieces;
}

function markdownRowCells(row: string): string[] {
	const cells: string[] = [];
	let cell = "";
	let escaped = false;
	for (const character of row.replace(/^\|/, "").replace(/\|$/, "")) {
		if (character === "|" && !escaped) {
			cells.push(cell.trim());
			cell = "";
		} else {
			cell += character;
		}
		if (character === "\\") escaped = !escaped;
		else escaped = false;
	}
	cells.push(cell.trim());
	return cells;
}

function splitLongTableRow(
	row: string,
	header: string,
	rowNumber: number,
	limit: number,
): string[] {
	const labels = markdownRowCells(header);
	const cells = markdownRowCells(row);
	const chunks: string[] = [];
	let current = `**Table row ${rowNumber}**`;
	for (const [index, cell] of cells.entries()) {
		const label = labels[index] || `Column ${index + 1}`;
		const marker = `- **${label}**: `;
		if (marker.length > limit - 100)
			throw new Error("Markdown table column label exceeds the chunk limit");
		for (const piece of splitLongLine(
			cell || "(empty)",
			limit - marker.length - 100,
		)) {
			const line = `${marker}${piece}`;
			if (current.length + line.length + 1 > limit) {
				chunks.push(current);
				current = `**Table row ${rowNumber} (continued)**`;
			}
			current += `\n${line}`;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

function splitLongBlock(block: string, limit: number): string[] {
	if (block.length <= limit) return [block];
	const lines = block.split("\n");
	const table =
		lines.length > 2 && /^\|/.test(lines[0]) && /^\|[\s|:-]+\|$/.test(lines[1]);
	const fence = /^(```|~~~)([^\n]*)/.exec(lines[0]);
	const tableHeader = table ? `${lines[0]}\n${lines[1]}\n` : "";
	if (table) {
		if (tableHeader.length >= limit)
			throw new Error("Markdown table header exceeds the chunk limit");
		const chunks: string[] = [];
		let rows: string[] = [];
		const flushRows = () => {
			if (rows.length) chunks.push(`${tableHeader}${rows.join("\n")}`);
			rows = [];
		};
		for (const [index, row] of lines.slice(2).entries()) {
			if (tableHeader.length + row.length > limit) {
				flushRows();
				chunks.push(...splitLongTableRow(row, lines[0], index + 2, limit));
				continue;
			}
			if (tableHeader.length + rows.join("\n").length + row.length + 1 > limit)
				flushRows();
			rows.push(row);
		}
		flushRows();
		return chunks;
	}
	const bodyLines = table ? lines.slice(2) : fence ? lines.slice(1, -1) : lines;
	const prefix = table ? tableHeader : fence ? `${fence[1]}${fence[2]}\n` : "";
	const suffix = fence ? `\n${fence[1]}` : "";
	const available = Math.max(100, limit - prefix.length - suffix.length);
	const chunks: string[] = [];
	let current = "";
	const pieces = bodyLines.flatMap((part) => splitLongLine(part, available));
	for (const line of pieces) {
		if (current && current.length + line.length + 1 > available) {
			chunks.push(`${prefix}${current}${suffix}`);
			current = "";
		}
		current += `${current ? "\n" : ""}${line}`;
	}
	if (current) chunks.push(`${prefix}${current}${suffix}`);
	return chunks;
}

function locationFromHeadings(headings: string[]): MarkdownSegment["location"] {
	const location: MarkdownSegment["location"] = {};
	for (const heading of headings) {
		const page = /^Page (\d+)$/i.exec(heading);
		const slide = /^Slide (\d+)$/i.exec(heading);
		const sheet = /^Sheet: (.+)$/i.exec(heading);
		const chapter = /^Chapter (\d+)$/i.exec(heading);
		if (page) location.page = Number(page[1]);
		if (slide) location.slide = Number(slide[1]);
		if (sheet) location.sheet = sheet[1];
		if (chapter) location.chapter = Number(chapter[1]);
	}
	return location;
}

function chunkMarkdown(markdown: string): MarkdownSegment[] {
	const blocks = markdownBlocks(markdown);
	const segments: MarkdownSegment[] = [];
	const headings: Array<{ level: number; text: string }> = [];
	let current = "";
	let currentHeadingPath: string[] = [];
	const flush = () => {
		if (!current.trim()) return;
		const firstHeading = /^#{1,6}\s+([^\n]+)/.exec(current)?.[1];
		const firstHeadingIndex = firstHeading
			? currentHeadingPath.indexOf(firstHeading)
			: -1;
		const ancestorCount =
			firstHeadingIndex >= 0 ? firstHeadingIndex : currentHeadingPath.length;
		const prefix =
			ancestorCount > 0
				? `${currentHeadingPath
						.slice(0, ancestorCount)
						.map(
							(heading, index) =>
								`${"#".repeat(Math.min(index + 1, 6))} ${heading}`,
						)
						.join("\n\n")}\n\n`
				: "";
		const content = normalizeMarkdown(prefix + current);
		if (content.length > MAX_CHUNK_CHARS)
			throw new Error("Markdown chunk exceeds the 1,800 character limit");
		segments.push({
			content,
			headingPath: [...currentHeadingPath],
			location: locationFromHeadings(currentHeadingPath),
		});
		current = "";
	};
	for (const block of blocks) {
		const heading = /^(#{1,6})\s+(.+)$/.exec(block);
		if (heading) {
			if (
				current &&
				!/^(?:#{1,6}\s+[^\n]+)(?:\n\n#{1,6}\s+[^\n]+)*$/.test(current)
			)
				flush();
			const level = heading[1].length;
			while (headings.length && (headings.at(-1)?.level ?? 0) >= level)
				headings.pop();
			headings.push({ level, text: heading[2] });
		}
		const path = headings.map((item) => item.text);
		for (const piece of splitLongBlock(block, MAX_CHUNK_CHARS - 400)) {
			if (current && current.length + piece.length + 2 > MAX_CHUNK_CHARS - 300)
				flush();
			if (
				!current ||
				(heading &&
					/^(?:#{1,6}\s+[^\n]+)(?:\n\n#{1,6}\s+[^\n]+)*$/.test(current))
			)
				currentHeadingPath = path;
			current += `${current ? "\n\n" : ""}${piece}`;
		}
	}
	flush();
	return segments;
}

export async function convertWorkshopDocumentToMarkdown(input: {
	runDir: string;
	inputPath: string;
	outputDir?: string;
	sourceId?: string;
	originalName?: string;
}): Promise<WorkshopDocumentMarkdownResult> {
	const runDir = await realpath(input.runDir);
	const inputsDir = await realpath(join(runDir, "inputs"));
	const inputPath = await realpath(resolve(runDir, input.inputPath));
	if (
		!isWithin(inputsDir, inputPath) ||
		inputPath === inputsDir ||
		inputPath === join(inputsDir, "index.json")
	) {
		throw new Error(
			"Document source must be a staged file under this Work run's inputs directory",
		);
	}
	const fileInfo = await stat(inputPath);
	if (!fileInfo.isFile() || fileInfo.size > MAX_SOURCE_BYTES) {
		throw new Error("Document source is not a file or exceeds 100 MiB");
	}
	const format = extname(inputPath).toLowerCase();
	if (!SUPPORTED_FORMATS.has(format))
		throw new Error(`Unsupported document format: ${format || "(none)"}`);
	const originalName = input.originalName
		? basename(input.originalName)
		: basename(inputPath);
	const bytes = await readFile(inputPath);
	const sourceHash = sha256(bytes);
	const warnings: string[] = [];
	const extracted = await parseDocument(bytes, format, originalName, warnings);
	const substance = extracted
		.replace(/^#{1,6}\s+.*$/gm, "")
		.replace(/\[Image omitted\]/g, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.trim();
	if (!substance) {
		throw new Error(
			"Document contains no extractable text; scanned or image-only files require OCR",
		);
	}
	const document = normalizeMarkdown(
		/^#{1,6}\s/.test(extracted.trimStart())
			? extracted
			: `# ${titleFor(originalName)}\n\n${extracted}`,
	);
	const segments = chunkMarkdown(document);
	if (segments.length === 0)
		throw new Error("Document produced no Markdown chunks");

	const outputsRoot = join(runDir, "outputs");
	const canonicalOutputsRoot = await nearestExisting(outputsRoot);
	if (!isWithin(runDir, canonicalOutputsRoot))
		throw new Error("Outputs directory resolves outside this Work run");
	await mkdir(outputsRoot, { recursive: true });
	const requestedDir = input.outputDir
		? resolve(runDir, input.outputDir)
		: join(
				outputsRoot,
				`${titleFor(originalName)
					.replace(/[^a-zA-Z0-9._-]/g, "_")
					.slice(
						0,
						64,
					)}-${input.sourceId ? `${sha256(input.sourceId).slice(0, 12)}-` : ""}${sourceHash.slice(0, 12)}`,
			);
	const outputDir = await nearestExisting(requestedDir);
	if (!isWithin(outputsRoot, outputDir) || outputDir === outputsRoot) {
		throw new Error(
			"Markdown output directory must be a child of this Work run's outputs directory",
		);
	}
	const outputParent = dirname(outputDir);
	if (!isWithin(outputsRoot, outputParent))
		throw new Error("Invalid Markdown output parent");
	await mkdir(outputParent, { recursive: true });
	if (!isWithin(outputsRoot, await nearestExisting(outputDir)))
		throw new Error("Output path escaped the Work run");

	const documentPath = join(outputDir, "document.md");
	const manifestPath = join(outputDir, "manifest.json");
	const chunkFiles = segments.map((segment, index) => ({
		index,
		fileName: `chunk-${String(index + 1).padStart(4, "0")}.md`,
		content: segment.content,
		sha256: sha256(segment.content),
		headingPath: segment.headingPath,
		location: segment.location,
	}));
	const manifest = {
		schemaVersion: CONVERTER_VERSION,
		source: {
			path: inputPath,
			fileName: basename(inputPath),
			originalName,
			sourceId: input.sourceId,
			format,
			sizeBytes: bytes.length,
			sha256: sourceHash,
		},
		conversion: { status: warnings.length ? "partial" : "complete", warnings },
		document: {
			fileName: "document.md",
			sha256: sha256(document),
			chars: document.length,
		},
		chunks: chunkFiles.map(
			({ index, fileName, sha256: hash, content, headingPath, location }) => ({
				index,
				fileName,
				sha256: hash,
				chars: content.length,
				headingPath,
				location,
			}),
		),
	};
	const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
	const result: WorkshopDocumentMarkdownResult = {
		source: {
			path: inputPath,
			sha256: sourceHash,
			format,
			sourceId: input.sourceId,
			originalName,
		},
		outputDir,
		documentPath,
		manifestPath,
		chunkCount: chunkFiles.length,
		chunks: chunkFiles.map(({ index, fileName, sha256: hash }) => ({
			index,
			path: join(outputDir, fileName),
			sha256: hash,
		})),
		warnings,
	};

	const verifyExisting = async () => {
		if (
			(await readFile(manifestPath, "utf8")) !== manifestText ||
			(await readFile(documentPath, "utf8")) !== document
		) {
			throw new Error(
				"Markdown output directory already contains different artifacts",
			);
		}
		for (const file of chunkFiles) {
			if (
				(await readFile(join(outputDir, file.fileName), "utf8")) !==
				file.content
			) {
				throw new Error(
					"Markdown output directory already contains different artifacts",
				);
			}
		}
		return result;
	};
	try {
		await stat(outputDir);
		return await verifyExisting();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const stagingDir = join(
		outputParent,
		`.${basename(outputDir)}-${randomUUID()}.tmp`,
	);
	await mkdir(stagingDir);
	try {
		await writeFile(join(stagingDir, "document.md"), document, "utf8");
		for (const file of chunkFiles)
			await writeFile(join(stagingDir, file.fileName), file.content, "utf8");
		await writeFile(join(stagingDir, "manifest.json"), manifestText, "utf8");
		try {
			await rename(stagingDir, outputDir);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "EEXIST" &&
				(error as NodeJS.ErrnoException).code !== "EPERM"
			)
				throw error;
			return await verifyExisting();
		}
	} finally {
		await rm(stagingDir, { recursive: true, force: true });
	}
	return result;
}
