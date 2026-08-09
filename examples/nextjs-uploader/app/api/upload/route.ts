import { NextResponse } from "next/server";
import { uploadFile } from "@/lib/s3";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const key = `${Date.now()}-${file.name}`;
  const body = Buffer.from(await file.arrayBuffer());

  await uploadFile(key, body, file.type || "application/octet-stream");

  return NextResponse.json({ key });
}
