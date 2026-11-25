/**
 * Minimal ustar writer: the judge sends each runner container one tar archive on stdin.
 * File names are always chosen by the judge itself (never by a submission).
 */
export interface TarEntry {
  name: string;
  data: Buffer | string;
}

function header(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar name too long: ${name}`);
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, "utf8");
  h.write("0000644\0", 100); // mode
  h.write("0001750\0", 108); // uid 1000
  h.write("0001750\0", 116); // gid 1000
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136); // mtime 0: deterministic archives
  h.write("        ", 148); // checksum placeholder
  h.write("0", 156); // regular file
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

export function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data;
    parts.push(header(e.name, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}
