"use strict";

// Zero-framework example: serves the static page and mints presigned PUT URLs
// so the browser can upload straight to storage without proxying through this
// server. Requires the bucket's corsOrigins to allow the page's origin.

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  region: process.env.R2_REGION || "us-east-1",
  endpoint: process.env.R2_ENDPOINT,
  forcePathStyle: true, // REQUIRED
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET;
const PORT = process.env.PORT || 3000;

async function presignPut(key, contentType, expiresIn = 900) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn }
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    return;
  }

  if (req.method === "POST" && req.url === "/presign-put") {
    try {
      const { key, contentType } = await readBody(req);
      if (!key) return res.writeHead(400).end("missing key");
      const url = await presignPut(key, contentType || "application/octet-stream");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, () => console.log(`Open http://localhost:${PORT}`));
