import { describe, expect, it } from "vitest";
import { azDownloadArgs, azUploadArgs, shareRemote } from "./share.ts";

describe("shareRemote", () => {
	it("points each env at its own share", () => {
		expect(shareRemote("dev", "members.yaml")).toEqual({
			account: "pixeldevdata",
			share: "pixel",
			path: "members.yaml",
		});
		expect(shareRemote("prod", "data/x.yaml").account).toBe("pixelproddata");
	});
});

describe("az arguments", () => {
	it("use login auth and no shell", () => {
		const down = azDownloadArgs(shareRemote("dev", "home-assistant/devices.yaml"), "/tmp/x.yaml");
		expect(down.slice(0, 3)).toEqual(["storage", "file", "download"]);
		expect(down).toContain("login");
		expect(down[down.indexOf("--account-name") + 1]).toBe("pixeldevdata");
		expect(down[down.indexOf("--dest") + 1]).toBe("/tmp/x.yaml");
		const up = azUploadArgs(shareRemote("prod", "home-assistant/devices.yaml"), "/tmp/y.yaml");
		expect(up.slice(0, 3)).toEqual(["storage", "file", "upload"]);
		expect(up[up.indexOf("--source") + 1]).toBe("/tmp/y.yaml");
		expect(up[up.indexOf("--path") + 1]).toBe("home-assistant/devices.yaml");
	});
});
