import fs from 'fs'

export const parseStPng = (filePath: string): any | null => {
  try {
    const buffer = fs.readFileSync(filePath)
    let offset = 8 // skip PNG signature

    while (offset < buffer.length) {
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
                // Compressed, need zlib, skipping for MVP since ST usually uses uncompressed base64 tEXt
                console.warn('Compressed iTXt ST cards not supported yet')
                return null
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
    }
  } catch (error) {
    console.error('Failed to parse ST PNG:', error)
  }

  return null
}
