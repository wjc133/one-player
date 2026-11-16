use std::io::Cursor;

use image::{codecs::jpeg::JpegEncoder, ImageReader, Limits, Rgb, RgbImage};

const MAX_COVER_SIZE: u32 = 1024;

// ZX300 accepts baseline JPEG, but many music providers serve progressive JPEGs.
// Keep an already converted cover byte-for-byte to avoid losses on repeated edits.
pub(crate) fn normalize(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| format!("封面图片格式无法识别：{e}"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|e| format!("封面图片无法解码：{e}"))?;
    if baseline_rgb_jpeg(&bytes)
        && decoded.width() <= MAX_COVER_SIZE
        && decoded.height() <= MAX_COVER_SIZE
    {
        return Ok(bytes);
    }
    let resized = if decoded.width() > MAX_COVER_SIZE || decoded.height() > MAX_COVER_SIZE {
        decoded.thumbnail(MAX_COVER_SIZE, MAX_COVER_SIZE)
    } else {
        decoded
    };
    let rgba = resized.to_rgba8();
    // JPEG has no alpha channel. Composite transparency onto white before encoding.
    let rgb = RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let pixel = rgba.get_pixel(x, y);
        let alpha = u32::from(pixel[3]);
        Rgb([0, 1, 2].map(|channel| {
            ((u32::from(pixel[channel]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        }))
    });
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(&mut output, 90)
        .encode_image(&rgb)
        .map_err(|e| format!("转换 WALKMAN 封面失败：{e}"))?;
    Ok(output)
}

fn baseline_rgb_jpeg(bytes: &[u8]) -> bool {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return false;
    }
    let mut offset = 2;
    while offset + 4 <= bytes.len() && bytes[offset] == 0xff {
        let marker = bytes[offset + 1];
        offset += 2;
        if marker == 0xff {
            offset -= 1;
            continue;
        }
        let size = usize::from(u16::from_be_bytes([bytes[offset], bytes[offset + 1]]));
        if size < 2 || offset + size > bytes.len() {
            return false;
        }
        match marker {
            // Eight-bit, three-component baseline DCT; reject progressive/CMYK images.
            0xc0 => return size >= 8 && bytes[offset + 2] == 8 && bytes[offset + 7] == 3,
            0xc1..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => return false,
            0xda | 0xd9 => return false,
            _ => offset += size,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};

    #[test]
    fn converts_png_to_baseline_rgb_jpeg_and_repeated_saves_are_lossless() {
        let normalized = normalize(include_bytes!("../icons/32x32.png").to_vec()).unwrap();
        assert!(baseline_rgb_jpeg(&normalized));
        assert_eq!(normalize(normalized.clone()).unwrap(), normalized);
    }

    #[test]
    fn converts_progressive_jpeg_to_baseline_without_changing_size() {
        let progressive = include_bytes!("../tests/fixtures/progressive-cover.jpg").to_vec();
        assert!(!baseline_rgb_jpeg(&progressive));
        let converted = normalize(progressive).unwrap();
        assert!(baseline_rgb_jpeg(&converted));
        let decoded = image::load_from_memory(&converted).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (16, 16));
    }

    #[test]
    fn resizes_large_artwork_without_stretching_and_composites_alpha() {
        let original =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(2048, 1024, Rgba([0, 0, 0, 0])));
        let mut png = Cursor::new(Vec::new());
        original.write_to(&mut png, ImageFormat::Png).unwrap();
        let converted = normalize(png.into_inner()).unwrap();
        assert!(baseline_rgb_jpeg(&converted));
        let decoded = image::load_from_memory(&converted).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (1024, 512));
        assert!(decoded.get_pixel(0, 0).0.iter().all(|value| *value >= 250));
    }

    #[test]
    fn rejects_invalid_image_data() {
        assert!(normalize(b"not an image".to_vec()).is_err());
    }
}
