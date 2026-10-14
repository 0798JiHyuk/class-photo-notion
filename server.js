const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require("@notionhq/client");

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const NOTION_API_KEY = process.env.NOTION_API_KEY || "";
const NOTION_VERSION = process.env.NOTION_VERSION || "2026-03-11";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const UPLOAD_DIR = path.join(__dirname, "uploads");
const ACCESS_TOKEN =
  process.env.APP_ACCESS_TOKEN || createPairingCode();
const ACCESS_TOKEN_IS_EPHEMERAL = !process.env.APP_ACCESS_TOKEN;

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const notion = NOTION_API_KEY
  ? new Client({
      auth: NOTION_API_KEY,
      notionVersion: NOTION_VERSION,
    })
  : null;

const app = express();
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
      cb(null, `photo-${stamp}${ext}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
  },
});

let latestUpload = null;

app.use(express.json());
// Serve only the application entry point; never expose source or uploaded files.
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/index.html", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.get("/ping", (_req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
  });
});

app.get("/api/runtime", (_req, res) => {
  res.json({
    ok: true,
    notionConfigured: Boolean(NOTION_API_KEY),
    authRequired: true,
    accessTokenHint: ACCESS_TOKEN_IS_EPHEMERAL
      ? "서버 콘솔에 표시된 6자리 접속 코드를 입력하세요."
      : "설정한 APP_ACCESS_TOKEN을 입력하세요.",
    maxUploadMb: MAX_UPLOAD_MB,
    destinations: ["page", "database", "both", "local"],
    latestUpload,
  });
});

app.post("/api/upload", requireAccessToken, upload.single("photo"), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ ok: false, error: "사진 파일이 없습니다." });
  }

  const destinationMode = normalizeDestinationMode(req.body.destinationMode);
  const pageId = cleanNotionId(req.body.pageId || "");
  const databaseId = cleanNotionId(req.body.databaseId || "");
  const subject = String(req.body.subject || "수업").trim() || "수업";
  const blockTitle = String(req.body.blockTitle || "").trim();
  const databasePageTitle = String(req.body.databasePageTitle || "").trim();

  if (destinationMode !== "local" && !notion) {
    return res.status(400).json({
      ok: false,
      error: "노션 API 키가 설정되지 않았습니다. .env의 NOTION_API_KEY를 확인하세요.",
    });
  }

  if ((destinationMode === "page" || destinationMode === "both") && !pageId) {
    return res.status(400).json({ ok: false, error: "노션 페이지 ID가 필요합니다." });
  }

  if ((destinationMode === "database" || destinationMode === "both") && !databaseId) {
    return res.status(400).json({ ok: false, error: "노션 데이터베이스 ID가 필요합니다." });
  }

  try {
    const mimeType = getMimeType(file.originalname || file.filename);
    const notionResult =
      destinationMode === "local"
        ? { mode: "local" }
        : await sendPhotoToNotion({
            filePath: file.path,
            originalName: file.originalname || file.filename,
            mimeType,
            destinationMode,
            pageId,
            databaseId,
            subject,
            blockTitle,
            databasePageTitle,
          });

    const clipboard = copyImageToClipboard(file.path);
    latestUpload = {
      filename: file.filename,
      subject,
      savedAt: new Date().toISOString(),
      notionMode: destinationMode,
    };

    res.json({
      ok: true,
      filename: file.filename,
      savedPath: file.path,
      clipboard,
      notion: notionResult,
    });
  } catch (error) {
    console.error("업로드 실패:", error);
    res.status(500).json({
      ok: false,
      error: error.message || "업로드 중 오류가 발생했습니다.",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  const addresses = getCandidateAddresses();

  console.log("");
  console.log("========================================");
  console.log("  수업 사진 -> 노션/클립보드 서버 실행 중");
  console.log("========================================");

  if (addresses.length === 0) {
    console.log(`  브라우저 주소: http://localhost:${PORT}`);
  } else {
    console.log("  접속 가능한 주소:");
    for (const item of addresses) {
      console.log(`   - ${item.label}: http://${item.ip}:${PORT}`);
    }
  }

  if (ACCESS_TOKEN_IS_EPHEMERAL) {
    console.log("");
    console.log(`  접속 코드: ${ACCESS_TOKEN}`);
    console.log("  아이폰에서 처음 접속한 뒤 이 코드를 한 번 저장하면 됩니다.");
  } else {
    console.log("");
    console.log("  APP_ACCESS_TOKEN 환경변수를 사용 중입니다.");
  }

  if (NOTION_API_KEY) {
    console.log("  노션 연동: 활성화");
  } else {
    console.log("  노션 연동: 비활성화 (.env의 NOTION_API_KEY 필요)");
  }

  console.log("========================================");
  console.log("");
});

async function sendPhotoToNotion({
  filePath,
  originalName,
  mimeType,
  destinationMode,
  pageId,
  databaseId,
  subject,
  blockTitle,
  databasePageTitle,
}) {
  const uploadId = await uploadFileToNotion(filePath, originalName, mimeType);
  const timestamp = formatKoreanTimestamp(new Date());
  const captionText = blockTitle || `${subject} · ${timestamp}`;
  const caption = captionText
    ? [
        {
          type: "text",
          text: { content: captionText },
        },
      ]
    : [];

  const result = {
    uploadId,
    attachedToPage: null,
    createdDatabasePage: null,
  };

  if (destinationMode === "page" || destinationMode === "both") {
    await appendImageBlockToPage(pageId, uploadId, captionText, caption);
    result.attachedToPage = pageId;
  }

  if (destinationMode === "database" || destinationMode === "both") {
    const createdPageId = await createDatabaseEntryWithImage({
      databaseId,
      uploadId,
      captionText,
      caption,
      subject,
      databasePageTitle,
      timestamp,
    });
    result.createdDatabasePage = createdPageId;
  }

  return result;
}

async function uploadFileToNotion(filePath, originalName, mimeType) {
  const createResponse = await notionApiFetch("/file_uploads", {
    method: "POST",
    body: JSON.stringify({
      mode: "single_part",
      filename: originalName,
      content_type: mimeType,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  });

  const fileBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([fileBuffer], { type: mimeType }),
    sanitizeFilename(originalName),
  );

  const uploadResponse = await fetch(createResponse.upload_url, {
    method: "POST",
    headers: buildNotionHeaders(),
    body: form,
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`노션 파일 업로드 실패: ${uploadResponse.status} ${text}`);
  }

  const uploadJson = await uploadResponse.json();
  if (uploadJson.status !== "uploaded") {
    throw new Error("노션 파일 업로드가 완료 상태가 아닙니다.");
  }

  return createResponse.id;
}

async function appendImageBlockToPage(pageId, uploadId, captionText, caption) {
  const children = [
    {
      object: "block",
      type: "callout",
      callout: {
        rich_text: [
          {
            type: "text",
            text: { content: captionText },
          },
        ],
        icon: { emoji: "📸" },
        color: "gray_background",
      },
    },
    {
      object: "block",
      type: "image",
      image: {
        type: "file_upload",
        file_upload: { id: uploadId },
        caption,
      },
    },
  ];

  await notion.blocks.children.append({
    block_id: pageId,
    children,
  });
}

async function createDatabaseEntryWithImage({
  databaseId,
  uploadId,
  captionText,
  caption,
  subject,
  databasePageTitle,
  timestamp,
}) {
  const database = await notion.databases.retrieve({ database_id: databaseId });
  const titleProperty = findTitlePropertyName(database);
  if (!titleProperty) {
    throw new Error("데이터베이스의 제목 속성을 찾지 못했습니다.");
  }

  const titleText = databasePageTitle || `${subject} ${timestamp}`;
  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    properties: {
      [titleProperty]: {
        title: [
          {
            type: "text",
            text: { content: titleText },
          },
        ],
      },
    },
    children: [
      {
        object: "block",
        type: "callout",
        callout: {
          rich_text: [
            {
              type: "text",
              text: { content: captionText },
            },
          ],
          icon: { emoji: "📸" },
          color: "gray_background",
        },
      },
      {
        object: "block",
        type: "image",
        image: {
          type: "file_upload",
          file_upload: { id: uploadId },
          caption,
        },
      },
    ],
  });

  return page.id;
}

function findTitlePropertyName(database) {
  for (const [name, config] of Object.entries(database.properties || {})) {
    if (config && config.type === "title") {
      return name;
    }
  }
  return null;
}

async function notionApiFetch(endpoint, options = {}) {
  const response = await fetch(`https://api.notion.com/v1${endpoint}`, {
    ...options,
    headers: {
      ...buildNotionHeaders(),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`노션 API 오류: ${response.status} ${text}`);
  }

  return response.json();
}

function buildNotionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
  };
}

function requireAccessToken(req, res, next) {
  const bearer = req.headers.authorization || "";
  const bearerToken = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
  const directToken = String(req.headers["x-access-token"] || "").trim();
  const submitted = bearerToken || directToken;

  if (!submitted || submitted !== ACCESS_TOKEN) {
    return res.status(401).json({
      ok: false,
      error: "접속 코드가 올바르지 않습니다.",
    });
  }

  next();
}

function normalizeDestinationMode(value) {
  if (["page", "database", "both", "local"].includes(value)) {
    return value;
  }
  return "page";
}

function cleanNotionId(input) {
  const match = String(input).match(/[a-f0-9]{32}|[a-f0-9-]{36}/i);
  return match ? match[0].replace(/-/g, "") : "";
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return (
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".heic": "image/heic",
      ".heif": "image/heif",
      ".bmp": "image/bmp",
    }[ext] || "application/octet-stream"
  );
}

function sanitizeFilename(filename) {
  return String(filename || "photo.jpg").replace(/[^\w.\-가-힣 ]/g, "_");
}

function formatKoreanTimestamp(date) {
  return date.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function createPairingCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function copyImageToClipboard(filePath) {
  const normalizedPath = path.resolve(filePath);
  try {
    execFileSync(
      "PowerShell.exe",
      [
        "-NoProfile",
        "-STA",
        "-Command",
        [
          "Add-Type -AssemblyName System.Windows.Forms;",
          "Add-Type -AssemblyName System.Drawing;",
          `$img = [System.Drawing.Image]::FromFile('${normalizedPath.replace(/\\/g, "\\\\")}');`,
          "[System.Windows.Forms.Clipboard]::SetImage($img);",
          "$img.Dispose();",
        ].join(" "),
      ],
      { stdio: "ignore" },
    );
    return { ok: true, mode: "image" };
  } catch (_error) {
    try {
      execFileSync(
        "cmd.exe",
        ["/c", `echo ${normalizedPath}| clip`],
        { stdio: "ignore" },
      );
      return { ok: true, mode: "path" };
    } catch (fallbackError) {
      return {
        ok: false,
        mode: "none",
        error: fallbackError.message,
      };
    }
  }
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getCandidateAddresses() {
  const { networkInterfaces } = require("os");
  const items = [];

  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }

      items.push({
        ip: entry.address,
        label: classifyInterface(name, entry.address),
      });
    }
  }

  return items;
}

function classifyInterface(name, ip) {
  const lower = name.toLowerCase();
  if (
    lower.includes("apple") ||
    lower.includes("iphone") ||
    ip.startsWith("172.20.")
  ) {
    return "아이폰 연결";
  }
  if (lower.includes("wi-fi") || lower.includes("wireless") || lower.includes("wlan")) {
    return "Wi-Fi";
  }
  if (lower.includes("ethernet") || lower.includes("local area") || lower.includes("eth")) {
    return "유선";
  }
  return name;
}
