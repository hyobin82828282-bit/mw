// 암호 걸린 엑셀(xlsx) 복호화 — Office Agile(2010+) / Standard(2007) 암호화 지원. XLSX(SheetJS) 필요.
(function () {
  const te = new TextEncoder();
  const utf16 = s => { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { b[i * 2] = s.charCodeAt(i) & 255; b[i * 2 + 1] = s.charCodeAt(i) >> 8; } return b; };
  const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let p = 0; a.forEach(x => { o.set(x, p); p += x.length; }); return o; };
  const u32 = n => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const algo = h => ({ SHA1: 'SHA-1', 'SHA-1': 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512' })[h.toUpperCase().replace('-', '')] || h;
  const hash = async (h, d) => new Uint8Array(await crypto.subtle.digest(h, d));
  const fit = (b, n, pad) => { if (b.length >= n) return b.slice(0, n); const o = new Uint8Array(n).fill(pad); o.set(b); return o; };
  async function aesCbc(key, iv, data) {
    const k = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt', 'decrypt']);
    // WebCrypto는 PKCS7 패딩을 요구 → 가짜 패딩 블록을 붙여 no-padding 복호화
    const last = data.slice(data.length - 16);
    const padBlk = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last }, k, new Uint8Array(16).fill(16))).slice(0, 16);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, cat(data, padBlk)));
  }
  async function aesEcb(key, data) {
    const k = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt', 'decrypt']);
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 16) out.set(await aesCbc(key, new Uint8Array(16), data.slice(i, i + 16)), i);
    return out;
  }
  function isEncrypted(buf) {
    const b = new Uint8Array(buf);
    if (!(b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0)) return false;
    try { const c = XLSX.CFB.read(b, { type: 'array' }); return !!XLSX.CFB.find(c, 'EncryptionInfo'); } catch (e) { return false; }
  }
  async function decrypt(buf, password) {
    const cfb = XLSX.CFB.read(new Uint8Array(buf), { type: 'array' });
    const info = new Uint8Array(XLSX.CFB.find(cfb, 'EncryptionInfo').content);
    const pkg = new Uint8Array(XLSX.CFB.find(cfb, 'EncryptedPackage').content);
    const size = pkg[0] | (pkg[1] << 8) | (pkg[2] << 16) | (pkg[3] << 24), enc = pkg.slice(8);
    const vMajor = info[0] | (info[1] << 8), vMinor = info[2] | (info[3] << 8);
    const pw = utf16(password);
    if (vMajor === 4 && vMinor === 4) {
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(info.slice(8)), 'application/xml');
      const kd = doc.getElementsByTagName('keyData')[0];
      const ek = [...doc.getElementsByTagName('*')].find(e => e.localName === 'encryptedKey' && e.getAttribute('spinCount'));
      const H = algo(ek.getAttribute('hashAlgorithm')), spin = +ek.getAttribute('spinCount'), kb = +ek.getAttribute('keyBits') / 8;
      const salt = b64(ek.getAttribute('saltValue'));
      let h = await hash(H, cat(salt, pw));
      for (let i = 0; i < spin; i++) h = await hash(H, cat(u32(i), h));
      const blockKey = async blk => fit(await hash(H, cat(h, blk)), kb, 0x36);
      const vIn = await aesCbc(await blockKey(new Uint8Array([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79])), salt, b64(ek.getAttribute('encryptedVerifierHashInput')));
      const vHash = await aesCbc(await blockKey(new Uint8Array([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e])), salt, b64(ek.getAttribute('encryptedVerifierHashValue')));
      const calc = await hash(H, vIn.slice(0, +ek.getAttribute('saltSize')));
      if (!calc.every((x, i) => x === vHash[i])) throw Object.assign(new Error('비밀번호가 맞지 않습니다.'), { code: 'bad_password' });
      const key = (await aesCbc(await blockKey(new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6])), salt, b64(ek.getAttribute('encryptedKeyValue')))).slice(0, kb);
      const kdSalt = b64(kd.getAttribute('saltValue')), kdH = algo(kd.getAttribute('hashAlgorithm')), bs = +kd.getAttribute('blockSize');
      const out = new Uint8Array(enc.length);
      for (let off = 0, seg = 0; off < enc.length; off += 4096, seg++) {
        const iv = fit(await hash(kdH, cat(kdSalt, u32(seg))), bs, 0x36);
        out.set(await aesCbc(key, iv, enc.slice(off, Math.min(off + 4096, enc.length))), off);
      }
      return out.slice(0, size);
    }
    if ((vMajor === 3 || vMajor === 4) && vMinor === 2) {
      const dv = new DataView(info.buffer, info.byteOffset), hSize = dv.getUint32(8, true);
      const hdr = 12, keyBits = dv.getUint32(hdr + 16, true) || 128, vs = hdr + hSize;
      const salt = info.slice(vs + 4, vs + 20), eVer = info.slice(vs + 20, vs + 36), eVerHash = info.slice(vs + 40, vs + 72);
      let h = await hash('SHA-1', cat(salt, pw));
      for (let i = 0; i < 50000; i++) h = await hash('SHA-1', cat(u32(i), h));
      h = await hash('SHA-1', cat(h, u32(0)));
      const x1 = await hash('SHA-1', new Uint8Array(64).fill(0x36).map((v, i) => i < 20 ? v ^ h[i] : v));
      const x2 = await hash('SHA-1', new Uint8Array(64).fill(0x5c).map((v, i) => i < 20 ? v ^ h[i] : v));
      const key = cat(x1, x2).slice(0, keyBits / 8);
      const ver = await aesEcb(key, eVer), verHash = await aesEcb(key, eVerHash), calc = await hash('SHA-1', ver);
      if (!calc.every((x, i) => x === verHash[i])) throw Object.assign(new Error('비밀번호가 맞지 않습니다.'), { code: 'bad_password' });
      return (await aesEcb(key, enc.slice(0, enc.length - (enc.length % 16)))).slice(0, size);
    }
    throw new Error('지원하지 않는 암호화 방식입니다.');
  }
  window.OfficeDecrypt = { isEncrypted, decrypt };
})();
