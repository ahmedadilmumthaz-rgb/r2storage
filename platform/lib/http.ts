import { NextResponse } from 'next/server';

export function ok(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function fail(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function parseBody<T>(req: Request): Promise<T> {
  return req.json() as Promise<T>;
}
