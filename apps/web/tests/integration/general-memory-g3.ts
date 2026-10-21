import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { closeDb } from "@/lib/db/adapters";
import { checkMemoryModuleT3 } from "./memory-module-t3.check";
import { checkMemoryModuleT4 } from "./memory-module-t4.check";
import { checkMemoryModuleT7 } from "./memory-module-t7.check";

async function main() {
	assert.equal(process.env.ZHIYU_TEST_MODE, "integration");
	assert.match(
		new URL(process.env.POSTGRES_URL!).pathname,
		/^\/zhiyu_test_[a-f0-9]{32}$/,
	);
	assert.equal(process.env.POSTGRES_URL, process.env.ZHIYU_TEST_DATABASE_URL);
	const sql = postgres(process.env.POSTGRES_URL!, {
			max: 4,
			onnotice: () => {},
		}),
		checks: unknown[] = [];
	const save = () =>
		fs.writeFileSync(
			process.env.ZHIYU_LIFECYCLE_TEST_RESULT!,
			JSON.stringify({ passed: false, checks }, null, 2),
		);
	try {
		for (const run of [checkMemoryModuleT3, checkMemoryModuleT4]) {
			const result = await run(sql);
			assert.equal(result.passed, true);
			checks.push(result);
			save();
		}
		const owner = randomUUID();
		await sql`INSERT INTO "User"(id,email) VALUES (${owner},${owner + "@example.invalid"})`;
		await checkMemoryModuleT7(sql, owner, (result) => {
			checks.push(result);
			save();
		});
		fs.writeFileSync(
			process.env.ZHIYU_LIFECYCLE_TEST_RESULT!,
			JSON.stringify(
				{
					passed: true,
					checks,
					dailyDatabaseUsed: false,
					providerCalled: false,
				},
				null,
				2,
			),
		);
		console.log(JSON.stringify({ passed: true, groups: checks.length }));
	} finally {
		await sql.end();
		await closeDb();
	}
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
