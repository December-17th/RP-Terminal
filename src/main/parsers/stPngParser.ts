import fs from 'fs'
import zlib from 'zlib'

// Hard cap on a single compressed-iTXt chunk's INFLATED size (A1 hardening). The embedded card JSON is
// text; a legit card is far under this. Without a cap, `inflateSync` on a crafted chunk is an unbounded
// decompression-bomb vector. On breach `inflateSync` throws → the chunk is treated as unparseable (null).
const MAX_ITXT_OUTPUT = 16 * 1024 * 1024

export const parseStPng = (filePath: string): any | null => {
  try {
    const buffer = fs.readFileSync(filePath)
    let offset = 8 // skip PNG signature

    // Walk the PNG chunk structure. Stop at IEND: anything after it (e.g. an appended cartridge
    // ZIP — world-card-design.md §8) is NOT PNG chunk data and must never be read as a chunk.
    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(offset)
      const type = buffer.toString('ascii', offset + 4, offset + 8)

      if (type === 'tEXt' || type === 'iTXt') {
        const data = buffer.slice(offset + 8, offset + 8 + length)
        const nullIdx = data.indexOf(0)

        if (nullIdx !== -1) {
          const keyword = data.slice(0, nullIdx).toString('utf-8')

          if (keyword === 'chara' || keyword === 'ccv3') {
            let textData = ''
            if (type === 'tEXt') {
              textData = data.slice(nullIdx + 1).toString('utf-8')
            } else {
              // simplified iTXt
              // format: keyword (null), compression flag (1 byte), compression method (1 byte), language tag (null term), translated keyword (null term), text
              let i = nullIdx + 1
              const compressionFlag = data[i++]
              i++ // compression method (unused)
              while (i < data.length && data[i] !== 0) i++ // skip lang tag
              i++
              while (i < data.length && data[i] !== 0) i++ // skip translated keyword
              i++

              if (compressionFlag === 0) {
                textData = data.slice(i).toString('utf-8')
              } else {
                // Compressed iTXt (deflate) — supported per world-card-design.md §8 (S5). Bounded
                // output (A1 hardening): a crafted chunk that inflates past the cap throws → null.
                try {
                  textData = zlib
                    .inflateSync(data.slice(i), { maxOutputLength: MAX_ITXT_OUTPUT })
                    .toString('utf-8')
                } catch (e) {
                  console.warn('Failed to inflate compressed iTXt chunk:', e)
                  return null
                }
              }
            }

            try {
              // ST stores base64 encoded JSON
              const decoded = Buffer.from(textData, 'base64').toString('utf-8')
              return JSON.parse(decoded)
            } catch {
              // Maybe it wasn't base64? Try raw
              return JSON.parse(textData)
            }
          }
        }
      }

      offset += 12 + length // 4 length + 4 type + length data + 4 crc
      if (type === 'IEND') break
    }
  } catch (error) {
    console.error('Failed to parse ST PNG:', error)
  }

  return null
}

/** ZIP local-file-header signature prefix ("PK"). */
const ZIP_PREFIX = Buffer.from([0x50, 0x4b])

/**
 * Return the bytes of an appended cartridge ZIP that follow a PNG's `IEND` chunk, or `null` when the
 * file has no trailing ZIP. Walks the PNG chunk structure to find the end of the `IEND` chunk's CRC,
 * then checks whether the trailing bytes begin with the ZIP signature (`PK`, `0x50 0x4B`). This is the
 * S5 PNG-cartridge container (world-card-design.md §8); the caller (characterService import) hands the
 * returned bytes to the cartridge extractor. Reads the file independently of {@link parseStPng} — card
 * import is not a hot path.
 */
export const extractAppendedZip = (filePath: string): Buffer | null => {
  try {
    const buffer = fs.readFileSync(filePath)
    let offset = 8 // skip PNG signature
    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(offset)
      const type = buffer.toString('ascii', offset + 4, offset + 8)
      const next = offset + 12 + length
      if (type === 'IEND') {
        const trailing = buffer.slice(next)
        if (trailing.length >= 2 && trailing.subarray(0, 2).equals(ZIP_PREFIX)) return trailing
        return null
      }
      offset = next
    }
  } catch (error) {
    console.error('Failed to scan PNG for appended ZIP:', error)
  }
  return null
}
