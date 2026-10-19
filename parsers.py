import base64
import io
import os
import re
import struct
import xml.etree.ElementTree as ET
import zipfile
import zlib
from typing import Any, Dict, List, Tuple


def parse_hwpx_bytes(data: bytes, filename: str = "document.hwpx") -> Dict[str, Any]:
    """
    Parse an HWPX (OWPML ZIP) file and extract:
    - paragraphs & tables text
    - HWP equation scripts (converted/annotated for readability)
    - embedded images from BinData/
    """
    paragraphs: List[str] = []
    equations: List[str] = []
    images: List[Dict[str, str]] = []

    with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
        namelist = zf.namelist()
        # Sort section XML files in order: Contents/section0.xml, section1.xml, ...
        section_files = sorted(
            [n for n in namelist if re.match(r"^Contents/section\d+\.xml$", n, re.IGNORECASE)]
        )
        if not section_files:
            section_files = sorted(
                [n for n in namelist if n.lower().endswith(".xml") and "section" in n.lower()]
            )

        for sec_name in section_files:
            xml_bytes = zf.read(sec_name)
            try:
                root = ET.fromstring(xml_bytes)
            except ET.ParseError:
                continue

            for elem in root.iter():
                local_tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
                if local_tag == "p":
                    # Collect text and equation scripts within this paragraph
                    parts: List[str] = []
                    for sub in elem.iter():
                        sub_tag = sub.tag.split("}")[-1] if "}" in sub.tag else sub.tag
                        if sub_tag == "t" and sub.text:
                            parts.append(sub.text)
                        elif sub_tag == "script" and sub.text:
                            eq_str = sub.text.strip()
                            if eq_str:
                                equations.append(eq_str)
                                parts.append(f" [수식: {eq_str}] ")
                    line = "".join(parts).strip()
                    if line:
                        # Avoid duplicate adjacent lines from nested <hp:p> inside tables/captions
                        if not paragraphs or paragraphs[-1] != line:
                            paragraphs.append(line)

        # Extract embedded images from BinData/
        for name in namelist:
            lower = name.lower()
            if lower.startswith("bindata/") and lower.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")):
                img_bytes = zf.read(name)
                if len(img_bytes) > 0 and len(img_bytes) < 10 * 1024 * 1024:
                    ext = os.path.splitext(lower)[1].lstrip(".")
                    mime = f"image/{'jpeg' if ext == 'jpg' else ext}"
                    images.append({
                        "name": os.path.basename(name),
                        "mime_type": mime,
                        "data_base64": base64.b64encode(img_bytes).decode("ascii"),
                    })

    full_text = "\n".join(paragraphs)
    return {
        "file_type": "hwpx",
        "filename": filename,
        "text": full_text,
        "equation_count": len(equations),
        "equations": equations[:100],
        "embedded_images": images[:20],
        "char_count": len(full_text),
    }


class SimpleOLE2Reader:
    """
    Minimal pure-Python OLE2 Compound Document reader for HWP v5 (.hwp) files.
    Supports reading FileHeader, PrvText, BodyText/Section*, and BinData/*.
    """

    ENDOFCHAIN = 0xFFFFFFFE
    FREESECT = 0xFFFFFFFF

    def __init__(self, data: bytes):
        self.data = data
        if len(data) < 512 or data[:8] != b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
            raise ValueError("유효한 HWP (OLE2) 파일 형식이 아닙니다.")

        u_sector_shift = struct.unpack_from("<H", data, 30)[0]
        u_mini_sector_shift = struct.unpack_from("<H", data, 32)[0]
        self.sector_size = 1 << u_sector_shift
        self.mini_sector_size = 1 << u_mini_sector_shift

        self.num_fat_sectors = struct.unpack_from("<I", data, 44)[0]
        self.first_dir_sector = struct.unpack_from("<I", data, 48)[0]
        self.mini_stream_cutoff = struct.unpack_from("<I", data, 56)[0]
        self.first_minifat_sector = struct.unpack_from("<I", data, 60)[0]
        self.num_minifat_sectors = struct.unpack_from("<I", data, 64)[0]
        self.first_difat_sector = struct.unpack_from("<I", data, 68)[0]
        self.num_difat_sectors = struct.unpack_from("<I", data, 72)[0]

        # Read DIFAT array (first 109 entries in header)
        difat: List[int] = list(struct.unpack_from("<109I", data, 76))
        curr_difat = self.first_difat_sector
        entries_per_sector = (self.sector_size // 4) - 1
        for _ in range(self.num_difat_sectors):
            if curr_difat >= self.ENDOFCHAIN:
                break
            sec_data = self._get_sector(curr_difat)
            vals = struct.unpack(f"<{self.sector_size // 4}I", sec_data)
            difat.extend(vals[:entries_per_sector])
            curr_difat = vals[entries_per_sector]

        difat = [s for s in difat if s < self.ENDOFCHAIN]

        # Build FAT
        self.fat: List[int] = []
        for fat_sec in difat[: self.num_fat_sectors]:
            sec_data = self._get_sector(fat_sec)
            self.fat.extend(struct.unpack(f"<{self.sector_size // 4}I", sec_data))

        # Read Directory stream
        dir_bytes = self._read_chain(self.first_dir_sector)
        self.entries: List[Dict[str, Any]] = []
        for offset in range(0, len(dir_bytes), 128):
            entry = dir_bytes[offset : offset + 128]
            if len(entry) < 128:
                break
            name_len = struct.unpack_from("<H", entry, 64)[0]
            obj_type = entry[66]
            if obj_type == 0 or name_len <= 2:
                self.entries.append({"name": "", "type": 0})
                continue
            name = entry[: max(0, name_len - 2)].decode("utf-16le", errors="ignore")
            left_sib, right_sib, child_id = struct.unpack_from("<3I", entry, 68)
            start_sec = struct.unpack_from("<I", entry, 116)[0]
            size = struct.unpack_from("<Q", entry, 120)[0]
            if self.sector_size == 512:
                size = size & 0xFFFFFFFF
            self.entries.append({
                "name": name,
                "type": obj_type,
                "left": left_sib,
                "right": right_sib,
                "child": child_id,
                "start": start_sec,
                "size": size,
            })

        # Build MiniFAT and MiniStream (from Root Entry)
        self.minifat: List[int] = []
        if self.first_minifat_sector < self.ENDOFCHAIN and self.num_minifat_sectors > 0:
            mf_bytes = self._read_chain(self.first_minifat_sector)
            self.minifat = list(struct.unpack(f"<{len(mf_bytes) // 4}I", mf_bytes))

        self.mini_stream = b""
        if self.entries and self.entries[0]["type"] == 5:
            self.mini_stream = self._read_chain(self.entries[0]["start"], self.entries[0]["size"])

        # Traverse directory tree to build path map
        self.streams: Dict[str, Dict[str, Any]] = {}
        if self.entries and self.entries[0].get("child", 0xFFFFFFFF) != 0xFFFFFFFF:
            self._traverse_dir(self.entries[0]["child"], "")

    def _get_sector(self, sector_id: int) -> bytes:
        offset = (sector_id + 1) * self.sector_size
        return self.data[offset : offset + self.sector_size]

    def _read_chain(self, start_sector: int, max_size: int = 0) -> bytes:
        chunks: List[bytes] = []
        curr = start_sector
        visited = set()
        while curr < self.ENDOFCHAIN and curr not in visited and curr < len(self.fat):
            visited.add(curr)
            chunks.append(self._get_sector(curr))
            curr = self.fat[curr]
        result = b"".join(chunks)
        if max_size > 0:
            return result[:max_size]
        return result

    def _read_mini_chain(self, start_sector: int, size: int) -> bytes:
        chunks: List[bytes] = []
        curr = start_sector
        visited = set()
        while curr < self.ENDOFCHAIN and curr not in visited and curr < len(self.minifat):
            visited.add(curr)
            offset = curr * self.mini_sector_size
            chunks.append(self.mini_stream[offset : offset + self.mini_sector_size])
            curr = self.minifat[curr]
        return b"".join(chunks)[:size]

    def _traverse_dir(self, node_id: int, prefix: str, visited=None):
        if visited is None:
            visited = set()
        if node_id == 0xFFFFFFFF or node_id >= len(self.entries) or node_id in visited:
            return
        visited.add(node_id)
        entry = self.entries[node_id]
        if entry.get("left", 0xFFFFFFFF) != 0xFFFFFFFF:
            self._traverse_dir(entry["left"], prefix, visited)
        name = entry.get("name", "")
        full_path = f"{prefix}/{name}" if prefix else name
        if entry.get("type") == 2:  # Stream
            self.streams[full_path] = entry
        elif entry.get("type") == 1:  # Storage
            if entry.get("child", 0xFFFFFFFF) != 0xFFFFFFFF:
                self._traverse_dir(entry["child"], full_path, visited)
        if entry.get("right", 0xFFFFFFFF) != 0xFFFFFFFF:
            self._traverse_dir(entry["right"], prefix, visited)

    def read_stream(self, path: str) -> bytes:
        entry = self.streams.get(path)
        if not entry:
            # Case-insensitive lookup
            for k, v in self.streams.items():
                if k.lower() == path.lower():
                    entry = v
                    break
        if not entry:
            raise KeyError(f"Stream not found: {path}")
        size = entry["size"]
        if size == 0:
            return b""
        if size < self.mini_stream_cutoff and self.mini_stream:
            return self._read_mini_chain(entry["start"], size)
        return self._read_chain(entry["start"], size)


def _decode_hwp_para_text(payload: bytes) -> str:
    """
    Decode HWPTAG_PARA_TEXT (tag ID 67) UTF-16LE buffer.
    In HWP 5.0 spec:
    - Control chars 1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23 are inline/extended controls of 8 WCHARs (16 bytes total).
    - Control chars 4, 5, 6, 7, 8, 19, 20 are inline controls of 8 WCHARs (16 bytes total).
    - Control chars 0, 9 (tab), 10 (line break), 13 (para break), 24 (hyphen), 30, 31 are single WCHARs (2 bytes).
    """
    EXTENDED_OR_INLINE = {
        1, 2, 3, 4, 5, 6, 7, 8,
        11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23
    }
    chars: List[str] = []
    idx = 0
    n = len(payload)
    while idx + 1 < n:
        code = struct.unpack_from("<H", payload, idx)[0]
        if code in EXTENDED_OR_INLINE:
            idx += 16  # Skip the 8-wchar control block
        elif code == 9:
            chars.append("\t")
            idx += 2
        elif code in (10, 13):
            chars.append("\n")
            idx += 2
        elif code < 32:
            idx += 2
        else:
            try:
                ch = payload[idx : idx + 2].decode("utf-16le")
                chars.append(ch)
            except UnicodeDecodeError:
                pass
            idx += 2
    return "".join(chars).strip()


def _extract_hwp_eqedit_text(payload: bytes) -> str:
    """
    Extract equation script from HWPTAG_EQEDIT (tag ID 72).
    In HWP 5.0 EqEdit record:
    - Offset 0..3: property (UINT32)
    - Offset 4..5: script char length (WORD, number of WCHARs)
    - Offset 6..6+2*len: UTF-16LE equation script string
    """
    if len(payload) < 6:
        return ""
    char_len = struct.unpack_from("<H", payload, 4)[0]
    byte_len = char_len * 2
    if 6 + byte_len <= len(payload) and char_len > 0:
        eq = payload[6 : 6 + byte_len].decode("utf-16le", errors="ignore").strip()
        return eq
    return ""


def parse_hwp_bytes(data: bytes, filename: str = "document.hwp") -> Dict[str, Any]:
    """
    Parse HWP v5 (.hwp) binary file (or HWPX if a zip file is saved with .hwp extension).
    """
    # Check if the file is actually a ZIP (HWPX renamed as .hwp)
    if data[:4] == b"PK\x03\x04":
        return parse_hwpx_bytes(data, filename)

    ole = SimpleOLE2Reader(data)
    header = ole.read_stream("FileHeader")
    props = struct.unpack_from("<I", header, 36)[0] if len(header) >= 40 else 1
    is_compressed = bool(props & 0x01)
    is_encrypted = bool(props & 0x02)

    if is_encrypted:
        raise ValueError("암호 설정(배포용/암호화)된 HWP 파일입니다. 일반 HWP 또는 HWPX/PDF로 저장 후 업로드해 주세요.")

    paragraphs: List[str] = []
    equations: List[str] = []

    section_paths = sorted(
        [k for k in ole.streams.keys() if k.lower().startswith("bodytext/section")],
        key=lambda x: int(re.findall(r"\d+", x)[-1]) if re.findall(r"\d+", x) else 0,
    )

    for sec_path in section_paths:
        raw_sec = ole.read_stream(sec_path)
        if is_compressed:
            try:
                sec_data = zlib.decompress(raw_sec, -15)
            except zlib.error:
                try:
                    sec_data = zlib.decompress(raw_sec)
                except zlib.error:
                    sec_data = raw_sec
        else:
            sec_data = raw_sec

        pos = 0
        sec_len = len(sec_data)
        while pos + 4 <= sec_len:
            rec_header = struct.unpack_from("<I", sec_data, pos)[0]
            tag_id = rec_header & 0x3FF
            size = (rec_header >> 20) & 0xFFF
            pos += 4
            if size == 0xFFF:
                if pos + 4 > sec_len:
                    break
                size = struct.unpack_from("<I", sec_data, pos)[0]
                pos += 4
            payload = sec_data[pos : pos + size]
            pos += size

            # HWPTAG_PARA_TEXT = 67 (16 + 51)
            if tag_id == 67:
                txt = _decode_hwp_para_text(payload)
                if txt:
                    paragraphs.append(txt)
            # HWPTAG_EQEDIT = 72 (16 + 56)
            elif tag_id == 72:
                eq = _extract_hwp_eqedit_text(payload)
                if eq:
                    equations.append(eq)
                    if paragraphs:
                        paragraphs[-1] = f"{paragraphs[-1]} [수식: {eq}]"
                    else:
                        paragraphs.append(f"[수식: {eq}]")

    # Fallback to PrvText if BodyText had no text
    if not paragraphs and "PrvText" in ole.streams:
        prv = ole.read_stream("PrvText").decode("utf-16le", errors="ignore").strip()
        if prv:
            paragraphs.append(prv)

    # Extract embedded images from BinData
    images: List[Dict[str, str]] = []
    for k in sorted(ole.streams.keys()):
        lower = k.lower()
        if lower.startswith("bindata/") and lower.endswith((".png", ".jpg", ".jpeg", ".bmp", ".gif")):
            raw_bin = ole.read_stream(k)
            if is_compressed:
                try:
                    img_bytes = zlib.decompress(raw_bin, -15)
                except zlib.error:
                    img_bytes = raw_bin
            else:
                img_bytes = raw_bin
            if 0 < len(img_bytes) < 10 * 1024 * 1024:
                ext = os.path.splitext(lower)[1].lstrip(".")
                mime = f"image/{'jpeg' if ext == 'jpg' else ext}"
                images.append({
                    "name": os.path.basename(k),
                    "mime_type": mime,
                    "data_base64": base64.b64encode(img_bytes).decode("ascii"),
                })

    full_text = "\n".join(paragraphs)
    return {
        "file_type": "hwp",
        "filename": filename,
        "text": full_text,
        "equation_count": len(equations),
        "equations": equations[:100],
        "embedded_images": images[:20],
        "char_count": len(full_text),
    }


# HWP Equation Private Use Area (U+E000..U+E1FF) Character Decoder for KICE PDFs
_HWP_PUA_SPECIAL_MAP = {
    0xE03D: "0",
    0xE044: "(",
    0xE045: ")",
    0xE046: "-",
    0xE047: "=",
    0xE048: "+",
    0xE049: "-",
    0xE04A: "×",
    0xE04B: "÷",
    0xE04C: "±",
    0xE055: "<",
    0xE056: ">",
    0xE057: "≤",
    0xE058: "≥",
    0xE05B: "∫",
    0xE05C: "√",
    0xE067: "∑",
    0xE068: "∏",
    0xE06D: "/",
    0xE06E: "→",
    0xE09D: "α",
    0xE09E: "β",
    0xE09F: "γ",
    0xE0A0: "δ",
    0xE0A4: "θ",
    0xE0A7: "λ",
    0xE0A8: "μ",
    0xE0AC: "π",
    0xE0AE: "ρ",
    0xE0AF: "σ",
    0xE0B0: "τ",
    0xE0B2: "φ",
    0xE0B4: "ω",
    0xE101: "|",
}


def decode_kice_pua_text(text: str) -> str:
    """
    Convert KICE PDF HWP Equation PUA characters (U+E000..U+E1FF) into standard readable ASCII/Unicode math.
    """
    if not text:
        return ""
    out: List[str] = []
    for ch in text:
        code = ord(ch)
        if 0xE000 <= code <= 0xE019:
            out.append(chr(ord("A") + (code - 0xE000)))
        elif 0xE034 <= code <= 0xE03C:
            out.append(chr(ord("1") + (code - 0xE034)))
        elif 0xE0E5 <= code <= 0xE0FE:
            out.append(chr(ord("a") + (code - 0xE0E5)))
        elif code in _HWP_PUA_SPECIAL_MAP:
            out.append(_HWP_PUA_SPECIAL_MAP[code])
        elif 0xE000 <= code <= 0xF8FF:
            out.append(" ")
        else:
            out.append(ch)
    cleaned = "".join(out)
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    return cleaned
