import { NextResponse } from "next/server";
import { presignGet } from "@/lib/s3";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");
  if (!key) return NextResponse.json({ error: "Missing key" }, { status: 400 });

  const url = await presignGet(key, 3600);
  return NextResponse.json({ url });
}
