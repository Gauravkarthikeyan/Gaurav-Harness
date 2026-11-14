import { describe, expect, it } from "bun:test";
import { APP_NAME, APP_URL, CONFIG_DIR_NAME } from "../src/dirs";

describe("gk identity", () => {
	it("brands the app as gk with a .gk config root", () => {
		expect(APP_NAME).toBe("gk");
		expect(CONFIG_DIR_NAME).toBe(".gk");
		expect(APP_URL).toBe("https://github.com/Gauravkarthikeyan");
	});
});
