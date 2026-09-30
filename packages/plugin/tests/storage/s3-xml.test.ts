import { describe, expect, it } from "vitest";
import { parseErrorCode, parseListObjects } from "@/storage/adapters/s3-xml";

function listing(body: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>bucket</Name><Prefix>objects/</Prefix>${body}</ListBucketResult>`;
}

function keysOf(xml: string): string[] {
	return parseListObjects(xml).objects.map((object) => object.key);
}

describe("S3 listing responses", () => {
	it("reads every key in a page", () => {
		const xml = listing(
			`<Contents><Key>objects/aa</Key><Size>1</Size></Contents>` +
				`<Contents><Key>objects/bb</Key><Size>2</Size></Contents>`,
		);

		expect(keysOf(xml)).toEqual(["objects/aa", "objects/bb"]);
	});

	it("reads the validator of each object, decoded, or none when it lists none", () => {
		const xml = listing(
			`<Contents><Key>objects/aa</Key><ETag>&quot;abc&quot;</ETag></Contents>` +
				`<Contents><Key>objects/bb</Key></Contents>` +
				`<Contents><Key>objects/cc</Key><ETag> </ETag></Contents>`,
		);

		expect(parseListObjects(xml).objects).toEqual([
			{ key: "objects/aa", etag: '"abc"' },
			{ key: "objects/bb", etag: null },
			{ key: "objects/cc", etag: null },
		]);
	});

	it("reports the token that continues a truncated listing", () => {
		const xml = listing(
			`<IsTruncated>true</IsTruncated><Contents><Key>objects/aa</Key></Contents>` +
				`<NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>`,
		);

		expect(parseListObjects(xml).nextToken).toBe(
			"1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=",
		);
	});

	it("stops when the last page names no token", () => {
		const xml = listing(
			`<IsTruncated>false</IsTruncated><Contents><Key>objects/aa</Key></Contents>`,
		);

		expect(parseListObjects(xml).nextToken).toBeUndefined();
	});

	it("reads nothing from an empty bucket instead of failing", () => {
		expect(parseListObjects(listing("<KeyCount>0</KeyCount>"))).toEqual({
			objects: [],
		});
	});

	it("decodes a key that had to be escaped", () => {
		const xml = listing(
			`<Contents><Key>a &amp;amp; b/c&lt;d&gt;.md</Key></Contents>`,
		);

		// The ampersand is decoded last, or "&amp;amp;" would come back as "&".
		expect(keysOf(xml)).toEqual(["a &amp; b/c<d>.md"]);
	});

	it("does not take a Prefix or an Owner for a key", () => {
		const xml = listing(
			`<Contents><Owner><ID>abc</ID><DisplayName>me</DisplayName></Owner>` +
				`<Key>objects/aa</Key></Contents>`,
		);

		expect(keysOf(xml)).toEqual(["objects/aa"]);
	});

	it("refuses a truncated page that does not say how to continue", () => {
		// Under-reporting a listing is read as "the remote does not have these",
		// which is the input to deciding what to delete and what to upload.
		const xml = listing(
			`<IsTruncated>true</IsTruncated><Contents><Key>objects/aa</Key></Contents>`,
		);

		expect(() => parseListObjects(xml)).toThrow(/truncated/);
	});

	it("refuses a body that is not a listing at all", () => {
		expect(() =>
			parseListObjects("<html><body>404 Not Found</body></html>"),
		).toThrow(/ListBucketResult/);
	});

	it("refuses an incomplete listing instead of reporting missing objects", () => {
		expect(() =>
			parseListObjects("<ListBucketResult><KeyCount>0</KeyCount>"),
		).toThrow(/ListBucketResult/);
	});

	it("refuses a listing entry without a key", () => {
		expect(() =>
			parseListObjects(listing("<Contents><Size>1</Size></Contents>")),
		).toThrow(/without a key/);
	});

	it("reads a listing a backend qualified with a namespace prefix", () => {
		const xml =
			`<s3:ListBucketResult xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/">` +
			`<s3:Contents><s3:Key>objects/aa</s3:Key></s3:Contents></s3:ListBucketResult>`;

		expect(keysOf(xml)).toEqual(["objects/aa"]);
	});

	it("keeps the spaces a key is allowed to start and end with", () => {
		const xml = listing(`<Contents><Key> spaced .md </Key></Contents>`);

		expect(keysOf(xml)).toEqual([" spaced .md "]);
	});

	it("trims a token a backend pretty-printed onto its own line", () => {
		const xml = listing(
			`<IsTruncated>true</IsTruncated>
<NextContinuationToken>
  TOKEN
</NextContinuationToken>`,
		);

		// A token with a newline in it would be signed into the query string.
		expect(parseListObjects(xml).nextToken).toBe("TOKEN");
	});

	it("decodes a numeric character reference", () => {
		const xml = listing(`<Contents><Key>a&#38;b&#x2F;c.md</Key></Contents>`);

		expect(keysOf(xml)).toEqual(["a&b/c.md"]);
	});

	it("names the code of an error document", () => {
		const xml =
			`<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code>` +
			`<Message>The specified bucket does not exist</Message></Error>`;

		expect(parseErrorCode(xml)).toBe("NoSuchBucket");
	});

	it("reports no code for a body that carries none", () => {
		expect(parseErrorCode("")).toBeNull();
	});
});
