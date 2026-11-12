# DICOM Görüntüleyici

iPhone için web tabanlı DICOM görüntüleyici. GitHub Pages üzerinde çalışır. Ana ekrana eklenince uygulama gibi açılır ve çevrimdışı çalışır. Görüntüler cihazdan çıkmaz.

## Özellikler

- Dosyalar uygulamasından tek dosya, çoklu dosya veya ZIP açma
- Serileri otomatik gruplama ve konuma göre sıralama
- Kesit gezinme: parmakla kaydırma veya sağdaki çubuk
- Yakınlaştırma (iki parmak), çift dokunuşla sıfırlama
- Pencere ayarı: sürükleyerek veya hazır ayarlar (Beyin, Subdural, İnme, Kemik, Akciğer, Mediasten, Abdomen, Karaciğer, Dosya, Otomatik)
- Ölçüm: uzunluk (mm) ve elips ROI (ortalama HU, SS, min/maks, alan)
- Yan yana iki seri ve kesit eşleme (aynı koordinat sisteminde konuma göre)
- Ters çevirme, 90° döndürme, yatay çevirme
- Yön harfleri (R/L/A/P/H/F) ve hasta/çalışma bilgileri
- Sıkıştırma desteği: JPEG (8/12-bit), JPEG Lossless, JPEG-LS, JPEG 2000, HTJ2K, RLE

## Kullanım

1. Safari'de sayfayı açın.
2. Paylaş → **Ana Ekrana Ekle**.
3. **Aç** ile DICOM dosyalarını veya ZIP'i seçin.

## Yayınlama (GitHub Pages)

Settings → Pages → Source: **Deploy from a branch** → branch seçin, klasör: `/ (root)` → Save.

Yeni sürüm yayınlarken `sw.js` içindeki `VERSION` değerini artırın.

## Yerelde çalıştırma

```
python3 -m http.server 8000
```

Sonra `http://localhost:8000` adresini açın.

## Üçüncü taraf kütüphaneler (`vendor/`)

| Dosya | Kaynak | Lisans |
|---|---|---|
| `dicomParser.min.js` | dicom-parser 1.8.21 | MIT |
| `jszip.min.js` | JSZip 3.10.1 | MIT veya GPL-3.0 |
| `jpeg-lossless.js` | jpeg-lossless-decoder-js 2.1.2 | MIT |
| `jpeg-baseline.js` | @cornerstonejs/dicom-image-loader 5.17.1 `codecs/jpeg.js` (pdf.js kökenli). 12-bit seviye kayması hatası düzeltildi. | MIT |
| `openjpegwasm_decode.*` | @cornerstonejs/codec-openjpeg 1.3.6 | MIT |
| `charlswasm_decode.*` | @cornerstonejs/codec-charls 1.2.7 | MIT |

## Not

Bu uygulama tanısal kullanım için onaylı bir tıbbi cihaz değildir.
