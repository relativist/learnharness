import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type ProxyEnv = Record<string, string | undefined>;

const { proxyEnvironment, configureEnvironmentProxy } = require("../electron/proxy-env.cjs") as {
	proxyEnvironment(env: ProxyEnv): ProxyEnv | null;
	configureEnvironmentProxy(env?: ProxyEnv): () => void;
};

const PROXY_VARS = /^(?:all|http|https|no)_proxy$/i;
const childScript = String.raw`
const { configureEnvironmentProxy } = require(process.argv[1]);
const config = JSON.parse(process.argv[2]);
const restore = configureEnvironmentProxy(config.env);
(async () => {
	try {
		const response = await fetch(config.url, {
			method: "POST",
			headers: { authorization: "Bearer fixture" },
			body: "proxy-request-body",
		});
		const body = await response.text();
		let httpBody;
		if (config.httpUrl) {
			httpBody = await new Promise((resolve, reject) => {
				require("node:http").request(config.httpUrl, { method: "POST", headers: { "content-length": "12" } }, res => {
					const chunks = [];
					res.on("data", chunk => chunks.push(chunk));
					res.on("end", () => resolve(Buffer.concat(chunks).toString()));
				}).on("error", reject).end("http-payload");
			});
		}
		console.log(JSON.stringify({ status: response.status, body, httpBody }));
	} catch (error) {
		console.log(JSON.stringify({ errorCode: error.code || "unknown" }));
	} finally {
		restore();
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

function cleanProxyEnv(): NodeJS.ProcessEnv {
	return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !PROXY_VARS.test(name))), NODE_ENV: process.env.NODE_ENV ?? "test" };
}

function runFetch(env: ProxyEnv, url: string, options: { ca?: string; httpUrl?: string } = {}): Promise<{ status?: number; body?: string; httpBody?: string; errorCode?: string }> {
	const runtimeEnv = { ...cleanProxyEnv(), ...(options.ca ? { NODE_EXTRA_CA_CERTS: options.ca } : {}) };
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [
			"-e", childScript,
			path.resolve("electron/proxy-env.cjs"),
			JSON.stringify({ env, url, httpUrl: options.httpUrl }),
		], { env: runtimeEnv, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
		child.once("error", error => { clearTimeout(timer); reject(error); });
		child.once("exit", code => {
			clearTimeout(timer);
			try {
				assert.equal(code, 0, stderr);
				const output = stdout.trim().split("\n").at(-1);
				assert.ok(output, "child returned a JSON result");
				resolve(JSON.parse(output) as { status?: number; body?: string; httpBody?: string; errorCode?: string });
			} catch (error) { reject(error); }
		});
	});
}

function listen<T extends net.Server | http.Server | https.Server>(server: T): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve((server.address() as net.AddressInfo).port);
		});
	});
}

function close(server: net.Server | http.Server | https.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

function makeCertificate(directory: string): { key: string; cert: string } {
	const key = path.join(directory, "proxy-test-key.pem");
	const cert = path.join(directory, "proxy-test-cert.pem");
	const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-keyout", key, "-out", cert, "-subj", "/CN=proxy-target.invalid", "-addext", "subjectAltName=DNS:proxy-target.invalid"], { encoding: "utf8", timeout: 15_000 });
	if ((generated.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error("OpenSSL is required for the local HTTPS proxy test.");
	assert.equal(generated.status, 0, generated.stderr);
	return { key, cert };
}

describe("proxy environment", () => {
	it("normalizes shell variables and preserves exclusions without mutating the input", () => {
		const input = {
			HTTP_PROXY: "http://upper-http.invalid:8080",
			http_proxy: "http://lower-http.invalid:8080",
			NO_PROXY: "example.test,internal.test",
		} satisfies ProxyEnv;
		const original = { ...input };
		const actual = proxyEnvironment(input);
		assert.equal(actual?.HTTP_PROXY, "http://lower-http.invalid:8080");
		assert.equal(actual?.HTTPS_PROXY, "http://lower-http.invalid:8080");
		assert.equal(actual?.NO_PROXY, "example.test,internal.test,localhost,127.0.0.1,::1,[::1]");
		assert.deepEqual(input, original);
	});

	it("uses ALL_PROXY when protocol-specific variables are absent and keeps lowercase exclusions authoritative", () => {
		const actual = proxyEnvironment({
			ALL_PROXY: "http://shared-proxy.invalid:3128",
			NO_PROXY: "ignored.invalid",
			no_proxy: "chosen.invalid",
		});
		assert.equal(actual?.HTTP_PROXY, "http://shared-proxy.invalid:3128");
		assert.equal(actual?.HTTPS_PROXY, "http://shared-proxy.invalid:3128");
		assert.equal(actual?.no_proxy, "chosen.invalid,localhost,127.0.0.1,::1,[::1]");
		assert.equal(proxyEnvironment({}), null);
	});

	it("prefers HTTPS_PROXY, then ALL_PROXY, then HTTP_PROXY for HTTPS traffic", () => {
		const httpAndAll = proxyEnvironment({
			HTTP_PROXY: "http://http-only.invalid:8080",
			ALL_PROXY: "http://shared.invalid:8080",
		});
		assert.equal(httpAndAll?.HTTP_PROXY, "http://http-only.invalid:8080");
		assert.equal(httpAndAll?.HTTPS_PROXY, "http://shared.invalid:8080");
		const httpsSpecific = proxyEnvironment({
			HTTP_PROXY: "http://http-only.invalid:8080",
			ALL_PROXY: "http://shared.invalid:8080",
			HTTPS_PROXY: "http://https-specific.invalid:8080",
		});
		assert.equal(httpsSpecific?.HTTPS_PROXY, "http://https-specific.invalid:8080");
	});

	it("leaves Node's global HTTP agents alone when no proxy is configured", () => {
		const beforeHttp = http.globalAgent;
		const beforeHttps = https.globalAgent;
		const restore = configureEnvironmentProxy({});
		assert.equal(http.globalAgent, beforeHttp);
		assert.equal(https.globalAgent, beforeHttps);
		restore();
		assert.equal(http.globalAgent, beforeHttp);
		assert.equal(https.globalAgent, beforeHttps);
	});

	it("rejects unsupported proxy schemes without exposing credentials", () => {
		assert.throws(
			() => proxyEnvironment({ HTTPS_PROXY: "socks5://secret-user:secret-password@127.0.0.1:1080" }),
			(error: Error) => !error.message.includes("secret-user") && !error.message.includes("secret-password"),
		);
	});

	it("routes HTTPS fetch and HTTP request through the configured proxy, preserving POST and streaming", async () => {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-proxy-test-"));
		const { key, cert } = makeCertificate(scratch);
		const incoming: string[] = [];
		const target = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", chunk => chunks.push(Buffer.from(chunk)));
			req.on("end", () => {
				incoming.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""} ${Buffer.concat(chunks).toString()}`);
				res.writeHead(201, { "content-type": "text/plain" });
				res.write("stream-");
				setTimeout(() => res.end("complete"), 10);
			});
		});
		let connectCount = 0;
		const proxy = http.createServer((req, res) => {
			incoming.push(`proxy-http ${req.method} ${req.url}`);
			res.end("http-proxy-response");
		});
		proxy.on("connect", (_req, client, head) => {
			connectCount++;
			const upstream = net.connect((target.address() as net.AddressInfo).port, "127.0.0.1", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length) upstream.write(head);
				client.pipe(upstream).pipe(client);
			});
		});
		try {
			const targetPort = await listen(target);
			const proxyPort = await listen(proxy);
			const proxyUrl = `http://127.0.0.1:${proxyPort}`;
			const result = await runFetch(
				{ http_proxy: proxyUrl, https_proxy: proxyUrl, no_proxy: "" },
				"https://proxy-target.invalid/stream",
				{ ca: cert, httpUrl: "http://proxy-target.invalid/post" },
			);
			assert.deepEqual(result, { status: 201, body: "stream-complete", httpBody: "http-proxy-response" });
			assert.equal(connectCount, 1);
			assert.ok(incoming.includes("POST /stream Bearer fixture proxy-request-body"));
			assert.ok(incoming.includes("proxy-http POST http://proxy-target.invalid/post"));
		} finally {
			await Promise.all([close(proxy), close(target)]);
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("keeps loopback direct and honors an explicit NO_PROXY suffix", async () => {
		let proxyRequests = 0;
		const proxy = http.createServer((_req, res) => { proxyRequests++; res.end("must not receive local traffic"); });
		proxy.on("connect", (_req, socket) => { proxyRequests++; socket.destroy(); });
		const local = http.createServer((_req, res) => res.end("local-response"));
		try {
			const proxyPort = await listen(proxy);
			const localPort = await listen(local);
			const proxyUrl = `http://127.0.0.1:${proxyPort}`;
			const localResult = await runFetch({ HTTP_PROXY: proxyUrl }, "http://127.0.0.1:" + localPort);
			assert.equal(localResult.status, 200);
			assert.equal(localResult.body, "local-response");
			assert.equal(localResult.httpBody, undefined);
			assert.equal(proxyRequests, 0);
			const excluded = await runFetch({ HTTP_PROXY: proxyUrl, NO_PROXY: ".invalid" }, "http://proxy-target.invalid/");
			assert.ok(excluded.errorCode, "NO_PROXY target fails DNS directly");
			assert.equal(proxyRequests, 0);
		} finally {
			await Promise.all([close(proxy), close(local)]);
		}
	});
});
