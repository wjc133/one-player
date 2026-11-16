use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use id3::{TagLike, Version};
use lofty::{
    config::WriteOptions,
    file::{AudioFile, FileType, TaggedFileExt},
    picture::{Picture, PictureType},
    prelude::{Accessor, ItemKey},
    read_from_path,
    tag::{ItemValue, Tag, TagExt, TagItem, TagType},
};

use crate::downloads::DownloadMetadata;

pub const MARKER_KEY: &str = "ONE_PLAYER_DOWNLOADED_BY";
pub const IMPORT_KEY: &str = "ONE_PLAYER_IMPORT_SOURCE";
pub const TRACK_KEY: &str = "ONE_PLAYER_TRACK_KEY";

#[derive(Default)]
pub struct AudioTags {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_seconds: u64,
    pub cover_data_url: Option<String>,
    pub has_cover: bool,
    pub track_key: Option<String>,
    pub managed: bool,
    pub import_source: Option<String>,
}

pub fn audio_format(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp3" => Some("mp3"),
        "flac" => Some("flac"),
        "wav" => Some("wav"),
        "ape" => Some("ape"),
        "dsf" => Some("dsf"),
        "m4a" => Some("m4a"),
        "aac" => Some("aac"),
        "ogg" => Some("ogg"),
        "opus" => Some("opus"),
        "aif" | "aiff" => Some("aiff"),
        "wv" => Some("wv"),
        _ => None,
    }
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

fn dsf_header(file: &mut File) -> Result<(u64, u64), String> {
    let mut header = [0u8; 28];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    let offset = u64::from_le_bytes(header[20..28].try_into().unwrap());
    if &header[..4] != b"DSD "
        || u64::from_le_bytes(header[4..12].try_into().unwrap()) != 28
        || (offset != 0 && (offset < 28 || offset >= length))
    {
        return Err("DSF 文件头或标签位置无效".into());
    }
    Ok((length, offset))
}

fn read_dsf(path: &Path) -> Result<(id3::Tag, u64, u64), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let (length, offset) = dsf_header(&mut file)?;
    let tag = if offset == 0 {
        id3::Tag::new()
    } else {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        id3::Tag::read_from2(file).map_err(|e| format!("读取 DSF 标签失败：{e}"))?
    };
    Ok((tag, length, offset))
}

pub fn read_tags(path: &Path, with_cover: bool) -> Result<AudioTags, String> {
    if audio_format(path) == Some("dsf") {
        let (tag, _, _) = read_dsf(path)?;
        let values = |key: &str| {
            tag.extended_texts()
                .find(|item| item.description == key)
                .map(|item| item.value.clone())
        };
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let mut fmt = [0u8; 52];
        file.seek(SeekFrom::Start(28)).map_err(|e| e.to_string())?;
        let duration_seconds = if file.read_exact(&mut fmt).is_ok() && &fmt[..4] == b"fmt " {
            let rate = u32::from_le_bytes(fmt[28..32].try_into().unwrap()) as u64;
            u64::from_le_bytes(fmt[36..44].try_into().unwrap())
                .checked_div(rate)
                .unwrap_or(0)
        } else {
            0
        };
        return Ok(AudioTags {
            title: tag.title().unwrap_or_default().into(),
            artist: tag.artist().unwrap_or_default().into(),
            album: tag.album().unwrap_or_default().into(),
            duration_seconds,
            has_cover: tag.pictures().any(|p| !p.data.is_empty()),
            cover_data_url: with_cover
                .then(|| {
                    tag.pictures()
                        .find(|p| {
                            p.picture_type == id3::frame::PictureType::CoverFront
                                && !p.data.is_empty()
                        })
                        .or_else(|| tag.pictures().find(|p| !p.data.is_empty()))
                        .map(|p| data_url(&p.mime_type, &p.data))
                })
                .flatten(),
            track_key: values(TRACK_KEY),
            import_source: values(IMPORT_KEY),
            managed: values(MARKER_KEY).as_deref() == Some("One Player"),
        });
    }
    let file = read_from_path(path).map_err(|e| format!("读取音频标签失败：{e}"))?;
    let primary = file.primary_tag();
    let tags: Vec<&Tag> = primary
        .into_iter()
        .chain(
            file.tags()
                .iter()
                .filter(|tag| !primary.is_some_and(|p| std::ptr::eq(p, *tag))),
        )
        .collect();
    let value = |key: &str| {
        tags.iter().find_map(|t| {
            t.items()
                .find(|i| i.key() == &ItemKey::Unknown(key.into()))
                .and_then(|i| i.value().text())
                .map(str::to_string)
        })
    };
    // Lofty exposes APE cover art as binary items, rather than Tag::pictures().
    let ape_pictures: Vec<Picture> = tags
        .iter()
        .filter(|tag| tag.tag_type() == TagType::Ape)
        .flat_map(|tag| tag.items())
        .filter_map(|item| {
            let key = item.key().map_key(TagType::Ape, true)?;
            let standard_key = lofty::ape::APE_PICTURE_TYPES
                .iter()
                .find(|name| name.eq_ignore_ascii_case(key))?;
            Picture::from_ape_bytes(standard_key, item.value().binary()?).ok()
        })
        .collect();
    let pictures = || {
        tags.iter()
            .flat_map(|tag| tag.pictures())
            .chain(ape_pictures.iter())
    };
    let picture = pictures()
        .find(|p| p.pic_type() == PictureType::CoverFront && !p.data().is_empty())
        .or_else(|| pictures().find(|p| !p.data().is_empty()));
    Ok(AudioTags {
        title: tags
            .iter()
            .find_map(|t| t.title().filter(|s| !s.trim().is_empty()))
            .unwrap_or_default()
            .into_owned(),
        artist: tags
            .iter()
            .find_map(|t| t.artist().filter(|s| !s.trim().is_empty()))
            .unwrap_or_default()
            .into_owned(),
        album: tags
            .iter()
            .find_map(|t| t.album().filter(|s| !s.trim().is_empty()))
            .unwrap_or_default()
            .into_owned(),
        duration_seconds: file.properties().duration().as_secs(),
        has_cover: picture.is_some(),
        cover_data_url: if with_cover {
            picture.map(|p| {
                data_url(
                    p.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg"),
                    p.data(),
                )
            })
        } else {
            None
        },
        track_key: value(TRACK_KEY),
        import_source: value(IMPORT_KEY),
        managed: value(MARKER_KEY).as_deref() == Some("One Player"),
    })
}

pub fn write_tags(
    path: &Path,
    metadata: &DownloadMetadata,
    cover: Option<Vec<u8>>,
    managed: bool,
) -> Result<Option<String>, String> {
    // Existing artwork needs the same conversion as newly downloaded artwork.
    let cover = match cover {
        Some(bytes) => Some(bytes),
        None => read_tags(path, true)?
            .cover_data_url
            .map(|url| {
                let (_, data) = url.split_once(',').ok_or("内嵌封面数据无效")?;
                STANDARD.decode(data).map_err(|e| e.to_string())
            })
            .transpose()?,
    };
    let picture = cover
        .map(|bytes| {
            let bytes = crate::cover_art::normalize(bytes)?;
            let mut picture = Picture::from_reader(&mut std::io::Cursor::new(bytes))
                .map_err(|e| format!("封面图片无效：{e}"))?;
            picture.set_pic_type(PictureType::CoverFront);
            Ok::<_, String>(picture)
        })
        .transpose()?;
    let cover_url = picture.as_ref().map(|p| {
        data_url(
            p.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg"),
            p.data(),
        )
    });
    if audio_format(path) == Some("dsf") {
        let (mut tag, length, offset) = read_dsf(path)?;
        tag.set_title(&metadata.title);
        tag.set_artist(&metadata.artist);
        tag.set_album(&metadata.album);
        if managed {
            tag.add_frame(id3::frame::ExtendedText {
                description: MARKER_KEY.into(),
                value: "One Player".into(),
            });
        }
        if let Some(value) = &metadata.import_source {
            tag.add_frame(id3::frame::ExtendedText {
                description: IMPORT_KEY.into(),
                value: value.clone(),
            });
        }
        if let Some(value) = &metadata.track_key {
            tag.add_frame(id3::frame::ExtendedText {
                description: TRACK_KEY.into(),
                value: value.clone(),
            });
        }
        if let Some(picture) = picture {
            tag.remove_picture_by_type(id3::frame::PictureType::CoverFront);
            tag.add_frame(id3::frame::Picture {
                mime_type: picture
                    .mime_type()
                    .map(|m| m.as_str())
                    .unwrap_or("image/jpeg")
                    .into(),
                picture_type: id3::frame::PictureType::CoverFront,
                description: String::new(),
                data: picture.data().to_vec(),
            });
        }
        let mut bytes = Vec::new();
        tag.write_to(&mut bytes, Version::Id3v23)
            .map_err(|e| e.to_string())?;
        let start = if offset == 0 { length } else { offset };
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(start))
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        let new_length = start + bytes.len() as u64;
        file.set_len(new_length).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(12)).map_err(|e| e.to_string())?;
        file.write_all(&new_length.to_le_bytes())
            .map_err(|e| e.to_string())?;
        file.write_all(&start.to_le_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    } else {
        let mut file = read_from_path(path).map_err(|e| format!("读取音频标签失败：{e}"))?;
        let mut tag = file
            .primary_tag()
            .or_else(|| file.tags().first())
            .cloned()
            .unwrap_or_else(|| Tag::new(file.primary_tag_type()));
        if tag.tag_type() != file.primary_tag_type() {
            tag.re_map(file.primary_tag_type());
        }
        // Keep track numbers, dates, lyrics, replay gain and other existing metadata.
        tag.set_title(metadata.title.clone());
        tag.set_artist(metadata.artist.clone());
        tag.set_album(metadata.album.clone());
        if managed {
            tag.insert_unchecked(TagItem::new(
                ItemKey::Unknown(MARKER_KEY.into()),
                ItemValue::Text("One Player".into()),
            ));
        }
        if let Some(value) = &metadata.import_source {
            tag.insert_unchecked(TagItem::new(
                ItemKey::Unknown(IMPORT_KEY.into()),
                ItemValue::Text(value.clone()),
            ));
        }
        if let Some(value) = &metadata.track_key {
            tag.insert_unchecked(TagItem::new(
                ItemKey::Unknown(TRACK_KEY.into()),
                ItemValue::Text(value.clone()),
            ));
        }
        if let Some(picture) = picture {
            tag.remove_picture_type(PictureType::CoverFront);
            // APE stores artwork as a binary item; it is absent from Tag::pictures().
            if tag.tag_type() == TagType::Ape {
                tag.retain(|item| {
                    !item
                        .key()
                        .map_key(TagType::Ape, true)
                        .is_some_and(|key| key.eq_ignore_ascii_case("Cover Art (Front)"))
                });
            }
            tag.push_picture(picture);
        }
        if file.file_type() == FileType::Mpeg && rewrite_duplicate_mpeg_id3(path, &tag)? {
            // The reader merged all leading tags; the rewrite emitted that merged tag once.
            return Ok(cover_url);
        }
        if tag.tag_type() == TagType::Ape {
            // Generic Tag::save_to_path only writes APE text/binary items and drops pictures.
            // The native APE conversion stores pictures as standard Cover Art binary items.
            save_ape_tag_preserving_audio(path, &native_ape_tag(tag))?;
        } else {
            file.insert_tag(tag);
            file.save_to_path(path, WriteOptions::default())
                .map_err(|e| format!("写入音频标签失败：{e}"))?;
        }
    }
    Ok(cover_url)
}

pub(crate) fn normalize_embedded_cover(path: &Path) -> Result<Option<String>, String> {
    let tags = read_tags(path, false)?;
    if !tags.has_cover {
        return Ok(None);
    }
    let metadata = DownloadMetadata {
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        cover_url: None,
        track_key: tags.track_key,
        import_source: tags.import_source,
    };
    write_tags(path, &metadata, None, false)
}

fn save_ape_tag_preserving_audio(path: &Path, tag: &lofty::ape::ApeTag) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    let mut header = [0u8; 52];
    if length >= 52 && file.read_exact(&mut header).is_ok() && &header[..4] == b"MAC " {
        let version = u16::from_le_bytes(header[4..6].try_into().unwrap());
        if version >= 3980 {
            let field = |offset| {
                u64::from(u32::from_le_bytes(
                    header[offset..offset + 4].try_into().unwrap(),
                ))
            };
            let audio_end = [field(8), field(12), field(16), field(20), field(32)]
                .into_iter()
                .try_fold(field(24) | (field(28) << 32), u64::checked_add)
                .ok_or("APE 音频长度无效")?;
            let mut id3v1 = Vec::new();
            let mut footer_end = length;
            if length >= 128 {
                file.seek(SeekFrom::End(-128)).map_err(|e| e.to_string())?;
                let mut trailing = [0u8; 128];
                file.read_exact(&mut trailing).map_err(|e| e.to_string())?;
                if &trailing[..3] == b"TAG" {
                    footer_end -= 128;
                    id3v1.extend(trailing);
                }
            }
            if footer_end >= 32 {
                file.seek(SeekFrom::Start(footer_end - 32))
                    .map_err(|e| e.to_string())?;
                let mut footer = [0u8; 32];
                file.read_exact(&mut footer).map_err(|e| e.to_string())?;
                if &footer[..8] == b"APETAGEX" {
                    let size = u64::from(u32::from_le_bytes(footer[12..16].try_into().unwrap()));
                    let flags = u32::from_le_bytes(footer[20..24].try_into().unwrap());
                    let header_size = if flags & (1 << 31) != 0 { 32 } else { 0 };
                    let tag_start = footer_end
                        .checked_sub(size + header_size)
                        .ok_or("APE 标签长度无效")?;
                    if tag_start < audio_end {
                        if audio_end > footer_end - 32 {
                            return Err("APE 音频长度无效，无法安全更新封面".into());
                        }
                        // Some existing APEs overlap their tag header with the last audio bytes.
                        // Retain those exact bytes, and place the new tag after the declared audio.
                        let mut bytes = Vec::new();
                        tag.dump_to(&mut bytes, WriteOptions::default())
                            .map_err(|e| e.to_string())?;
                        file.seek(SeekFrom::Start(audio_end))
                            .map_err(|e| e.to_string())?;
                        file.write_all(&bytes)
                            .and_then(|_| file.write_all(&id3v1))
                            .map_err(|e| e.to_string())?;
                        let new_length = file.stream_position().map_err(|e| e.to_string())?;
                        file.set_len(new_length).map_err(|e| e.to_string())?;
                        return Ok(());
                    }
                }
            }
        }
    }
    drop(file);
    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("写入 APE 标签与封面失败：{e}"))
}

fn rewrite_duplicate_mpeg_id3(path: &Path, tag: &Tag) -> Result<bool, String> {
    let mut reader = File::open(path).map_err(|e| e.to_string())?;
    let metadata = reader.metadata().map_err(|e| e.to_string())?;
    let mut offset = 0u64;
    let mut count = 0;
    while offset.saturating_add(10) <= metadata.len() {
        reader
            .seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut header = [0u8; 10];
        reader.read_exact(&mut header).map_err(|e| e.to_string())?;
        if &header[..3] != b"ID3" {
            break;
        }
        if !(2..=4).contains(&header[3]) || header[6..10].iter().any(|byte| byte & 0x80 != 0) {
            return Err("MP3 的 ID3 标签头无效".into());
        }
        let size = header[6..10]
            .iter()
            .fold(0u64, |size, byte| (size << 7) | u64::from(*byte));
        let footer = if header[3] == 4 && header[5] & 0x10 != 0 {
            10
        } else {
            0
        };
        offset = offset
            .checked_add(10 + size + footer)
            .ok_or("MP3 的 ID3 标签大小无效")?;
        if offset > metadata.len() {
            return Err("MP3 的 ID3 标签超出文件长度".into());
        }
        count += 1;
    }
    if count < 2 {
        return Ok(false);
    }
    if offset >= metadata.len() || tag.tag_type() != TagType::Id3v2 {
        return Err("MP3 的标签或音频数据无效".into());
    }
    // Generic writers probe only past the first ID3 block. Rebuild one merged ID3 block,
    // preserving every byte after the original leading blocks (audio and trailing tags).
    let temporary = path.with_file_name(format!(
        ".id3-{}.{}",
        uuid::Uuid::new_v4(),
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        tag.dump_to(&mut output, WriteOptions::default())
            .map_err(|e| format!("写入 MP3 标签失败：{e}"))?;
        reader
            .seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut reader, &mut output).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        drop(reader);
        fs::set_permissions(&temporary, metadata.permissions()).map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        Ok(true)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn native_ape_tag(tag: Tag) -> lofty::ape::ApeTag {
    // Native conversion drops unmapped items; retain custom metadata and existing cover items.
    let custom_items: Vec<_> = tag
        .items()
        .filter_map(|item| {
            if let ItemKey::Unknown(key) = item.key() {
                lofty::ape::ApeItem::new(key.clone(), item.value().clone()).ok()
            } else {
                None
            }
        })
        .collect();
    let mut native = lofty::ape::ApeTag::from(tag);
    for item in custom_items {
        if native.get(item.key()).is_none() {
            native.insert(item);
        }
    }
    native
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires ONE_PLAYER_TAG_FIXTURE and ffmpeg; modifies only a temporary copy"]
    fn real_mp3_with_duplicate_id3_roundtrip() {
        let original = std::path::PathBuf::from(
            std::env::var("ONE_PLAYER_TAG_FIXTURE").expect("set ONE_PLAYER_TAG_FIXTURE"),
        );
        let directory = tempfile::tempdir().unwrap();
        let copy = directory.path().join(format!(
            ".staged.{}",
            original.file_name().unwrap().to_string_lossy()
        ));
        fs::copy(&original, &copy).unwrap();
        let checksum = |path: &Path| {
            let result = std::process::Command::new("ffmpeg")
                .args(["-v", "error", "-i"])
                .arg(path)
                .args(["-map", "0:a:0", "-f", "md5", "-"])
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            result.stdout
        };
        let before = checksum(&copy);
        assert!(lofty::probe::Probe::new(File::open(&copy).unwrap())
            .guess_file_type()
            .unwrap()
            .file_type()
            .is_none());
        let tags = read_tags(&copy, true).unwrap();
        let metadata = DownloadMetadata {
            title: tags.title.clone(),
            artist: tags.artist,
            album: tags.album,
            cover_url: None,
            track_key: None,
            import_source: None,
        };
        let cover = write_tags(
            &copy,
            &metadata,
            Some(include_bytes!("../icons/32x32.png").to_vec()),
            false,
        )
        .unwrap();
        let saved = read_tags(&copy, true).unwrap();
        assert_eq!(saved.title, metadata.title);
        assert_eq!(saved.artist, metadata.artist);
        assert_eq!(saved.album, metadata.album);
        assert!(saved.cover_data_url == cover, "cover was not embedded");
        assert_eq!(before, checksum(&copy), "decoded audio changed");
        assert!(lofty::probe::Probe::new(File::open(&copy).unwrap())
            .guess_file_type()
            .unwrap()
            .file_type()
            .is_some());
        // A second edit goes through the regular writer after normalization.
        write_tags(&copy, &metadata, None, false).unwrap();
        assert!(read_tags(&copy, true).unwrap().cover_data_url == cover);
        assert_eq!(before, checksum(&copy));
        println!(
            "{}: first and subsequent saves succeeded, cover persisted, decoded audio unchanged",
            original.file_name().unwrap().to_string_lossy()
        );
    }
    #[test]
    fn writes_cover_to_mp3_with_multiple_leading_id3_tags() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(".staged.song.mp3");
        let padded_tag = |tag: id3::Tag, version| {
            let mut bytes = Vec::new();
            tag.write_to(&mut bytes, version).unwrap();
            bytes.resize(4096, 0);
            let size = bytes.len() - 10;
            for index in 0..4 {
                bytes[6 + index] = ((size >> (7 * (3 - index))) & 0x7f) as u8;
            }
            bytes
        };
        let mut first = id3::Tag::new();
        first.set_title("旧标题");
        first.set_artist("原歌手");
        first.set_genre("Instrumental");
        let mut second = id3::Tag::new();
        second.set_title("GENJI");
        second.set_album("源氏ノスタルジー");
        let mut bytes = padded_tag(first, Version::Id3v23);
        bytes.extend(padded_tag(second, Version::Id3v24));
        let mut frame = vec![0u8; 417];
        frame[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x64]);
        let audio = frame.repeat(8);
        bytes.extend(&audio);
        std::fs::write(&path, bytes).unwrap();
        assert!(lofty::probe::Probe::open(&path)
            .unwrap()
            .guess_file_type()
            .unwrap()
            .file_type()
            .is_some());
        assert!(lofty::probe::Probe::new(File::open(&path).unwrap())
            .guess_file_type()
            .unwrap()
            .file_type()
            .is_none());
        assert_eq!(read_tags(&path, false).unwrap().title, "GENJI");
        let metadata = DownloadMetadata {
            title: "GENJI".into(),
            artist: "Rin'(凛)".into(),
            album: "源氏ノスタルジー".into(),
            cover_url: None,
            track_key: None,
            import_source: None,
        };
        let expected_cover = write_tags(
            &path,
            &metadata,
            Some(include_bytes!("../icons/32x32.png").to_vec()),
            false,
        )
        .unwrap();
        let read = read_tags(&path, true).unwrap();
        assert_eq!(read.title, metadata.title);
        assert_eq!(read.artist, metadata.artist);
        assert_eq!(read.cover_data_url, expected_cover);
        let mut file = File::open(&path).unwrap();
        let mut head = [0u8; 10];
        file.read_exact(&mut head).unwrap();
        let length = head[6..10]
            .iter()
            .fold(0u64, |size, byte| (size << 7) | *byte as u64);
        file.seek(SeekFrom::Start(10 + length)).unwrap();
        let mut remainder = Vec::new();
        file.read_to_end(&mut remainder).unwrap();
        assert_eq!(remainder, audio);
        let tagged = read_from_path(&path).unwrap();
        assert_eq!(
            tagged.primary_tag().unwrap().genre().as_deref(),
            Some("Instrumental")
        );
    }
    #[test]
    fn native_ape_conversion_preserves_custom_tags_and_embeds_cover_as_binary() {
        let mut tag = Tag::new(TagType::Ape);
        tag.insert_unchecked(TagItem::new(
            ItemKey::Unknown(MARKER_KEY.into()),
            ItemValue::Text("One Player".into()),
        ));
        let image = include_bytes!("../icons/32x32.png");
        let mut picture = Picture::from_reader(&mut std::io::Cursor::new(image)).unwrap();
        picture.set_pic_type(PictureType::CoverFront);
        tag.push_picture(picture);
        let ape = native_ape_tag(tag);
        assert_eq!(
            ape.get(MARKER_KEY).unwrap().value().text(),
            Some("One Player")
        );
        let cover = ape
            .get("Cover Art (Front)")
            .unwrap()
            .value()
            .binary()
            .unwrap();
        assert_eq!(
            Picture::from_ape_bytes("Cover Art (Front)", cover)
                .unwrap()
                .data(),
            image
        );
        let generic = Tag::from(ape);
        assert!(generic.pictures().is_empty());
        assert!(generic
            .items()
            .any(|item| item.key().map_key(TagType::Ape, true) == Some("Cover Art (Front)")));
    }

    #[test]
    fn ape_tag_replacement_preserves_bytes_overlapping_the_declared_audio() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("overlap.ape");
        let mut header = vec![0u8; 52 + 24 + 4 + 64];
        header[..4].copy_from_slice(b"MAC ");
        header[4..6].copy_from_slice(&3990u16.to_le_bytes());
        header[8..12].copy_from_slice(&52u32.to_le_bytes());
        header[12..16].copy_from_slice(&24u32.to_le_bytes());
        header[16..20].copy_from_slice(&4u32.to_le_bytes());
        header[24..28].copy_from_slice(&81u32.to_le_bytes());
        let mut old = lofty::ape::ApeTag::default();
        old.set_title("old title".into());
        old.dump_to(&mut header, WriteOptions::default()).unwrap();
        fs::write(&path, &header).unwrap();
        let protected = &header[..52 + 24 + 4 + 81];
        let mut updated = lofty::ape::ApeTag::default();
        updated.set_title("a different title with a different tag size".into());
        save_ape_tag_preserving_audio(&path, &updated).unwrap();
        let written = fs::read(&path).unwrap();
        assert_eq!(&written[..protected.len()], protected);
        assert_eq!(&written[protected.len()..protected.len() + 8], b"APETAGEX");
    }
    #[test]
    fn dsf_roundtrip_preserves_audio_and_updates_header() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("music.dsf");
        let mut original = b"DSD ".to_vec();
        original.extend(28u64.to_le_bytes());
        original.extend(128u64.to_le_bytes());
        original.extend(0u64.to_le_bytes());
        original.extend([42u8; 100]);
        std::fs::write(&path, &original).unwrap();
        let metadata = DownloadMetadata {
            title: "测试歌曲".into(),
            artist: "歌手".into(),
            album: "专辑".into(),
            cover_url: None,
            track_key: Some("wy_123".into()),
            import_source: Some("WALKMAN".into()),
        };
        let picture = include_bytes!("../icons/32x32.png").to_vec();
        let expected_cover = data_url(
            "image/jpeg",
            &crate::cover_art::normalize(picture.clone()).unwrap(),
        );
        for index in 0..2 {
            write_tags(
                &path,
                &metadata,
                if index == 0 {
                    Some(picture.clone())
                } else {
                    None
                },
                true,
            )
            .unwrap();
            let tags = read_tags(&path, false).unwrap();
            assert_eq!(tags.title, "测试歌曲");
            assert!(tags.managed);
            assert!(tags.has_cover);
            assert!(tags.cover_data_url.is_none());
            assert_eq!(
                read_tags(&path, true).unwrap().cover_data_url,
                Some(expected_cover.clone())
            );
            assert_eq!(tags.track_key.as_deref(), Some("wy_123"));
            let bytes = std::fs::read(&path).unwrap();
            assert_eq!(&bytes[28..128], &original[28..]);
            assert_eq!(
                u64::from_le_bytes(bytes[12..20].try_into().unwrap()),
                bytes.len() as u64
            );
            assert_eq!(u64::from_le_bytes(bytes[20..28].try_into().unwrap()), 128);
        }
    }

    #[test]
    fn saving_existing_progressive_cover_converts_it_without_a_new_cover_url() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("old.dsf");
        let progressive = include_bytes!("../tests/fixtures/progressive-cover.jpg");
        let mut tag = id3::Tag::new();
        tag.set_title("原歌曲");
        tag.set_artist("原歌手");
        tag.set_album("原专辑");
        tag.add_frame(id3::frame::Picture {
            mime_type: "image/jpeg".into(),
            picture_type: id3::frame::PictureType::CoverFront,
            description: String::new(),
            data: progressive.to_vec(),
        });
        let mut tag_bytes = Vec::new();
        tag.write_to(&mut tag_bytes, Version::Id3v23).unwrap();
        let mut original = b"DSD ".to_vec();
        original.extend(28u64.to_le_bytes());
        original.extend((128 + tag_bytes.len() as u64).to_le_bytes());
        original.extend(128u64.to_le_bytes());
        original.extend([42u8; 100]);
        original.extend(tag_bytes);
        fs::write(&path, &original).unwrap();
        let expected = data_url(
            "image/jpeg",
            &crate::cover_art::normalize(progressive.to_vec()).unwrap(),
        );
        assert_ne!(
            read_tags(&path, true).unwrap().cover_data_url,
            Some(expected.clone())
        );
        assert_eq!(
            normalize_embedded_cover(&path).unwrap(),
            Some(expected.clone())
        );
        let saved = read_tags(&path, true).unwrap();
        assert_eq!(saved.cover_data_url, Some(expected));
        assert_eq!(saved.title, "原歌曲");
        assert_eq!(saved.artist, "原歌手");
        assert_eq!(saved.album, "原专辑");
        assert_eq!(&fs::read(&path).unwrap()[28..128], &original[28..128]);
    }

    #[test]
    #[ignore = "requires ONE_PLAYER_COVER_FIXTURE and ffmpeg; modifies only a temporary copy"]
    fn existing_cover_compatibility_roundtrip() {
        let original = std::path::PathBuf::from(
            std::env::var("ONE_PLAYER_COVER_FIXTURE").expect("set ONE_PLAYER_COVER_FIXTURE"),
        );
        let directory = tempfile::tempdir().unwrap();
        let copy = directory.path().join(original.file_name().unwrap());
        fs::copy(&original, &copy).unwrap();
        let checksum = |path: &Path| {
            let output = std::process::Command::new("ffmpeg")
                .args(["-v", "error", "-i"])
                .arg(path)
                .args(["-map", "0:a:0", "-f", "md5", "-"])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        };
        let before_audio = checksum(&copy);
        let before = read_tags(&copy, true).unwrap();
        let before_cover = before.cover_data_url.unwrap();
        let raw = STANDARD
            .decode(before_cover.split_once(',').unwrap().1)
            .unwrap();
        let expected = data_url("image/jpeg", &crate::cover_art::normalize(raw).unwrap());
        assert_eq!(
            normalize_embedded_cover(&copy).unwrap(),
            Some(expected.clone())
        );
        let after = read_tags(&copy, true).unwrap();
        assert_eq!(after.title, before.title);
        assert_eq!(after.artist, before.artist);
        assert_eq!(after.album, before.album);
        assert_eq!(after.track_key, before.track_key);
        assert_eq!(after.managed, before.managed);
        assert_eq!(after.cover_data_url, Some(expected.clone()));
        let after_audio = checksum(&copy);
        if before_audio != after_audio {
            let retained = directory.keep();
            panic!(
                "decoded audio checksum changed; inspect {}",
                retained.display()
            );
        }
        assert_eq!(normalize_embedded_cover(&copy).unwrap(), Some(expected));
        assert_eq!(before_audio, checksum(&copy));
        println!(
            "{}: existing artwork normalized, metadata and decoded audio preserved",
            original.display()
        );
    }
    #[test]
    fn rejects_invalid_dsf_without_changing_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bad.dsf");
        std::fs::write(&path, [0u8; 128]).unwrap();
        assert!(read_tags(&path, false).is_err());
    }
}
