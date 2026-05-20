// DEPRECATED: The "More Stops" modal has been removed.
// Users now ask Penny for stop suggestions instead.
// This file can be safely deleted.

import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    { error: 'This endpoint has been removed. Use Penny to find stops.' },
    { status: 410 }
  );
}
