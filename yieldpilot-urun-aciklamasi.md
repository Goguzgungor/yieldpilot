# YieldPilot · Stellar — Ürün Açıklaması

> **Tek cümlelik tanım:** Atıl duran USDC'niz için en iyi DeFi getirisini gece gündüz avlayan, parayı sizin risk toleransınıza göre en yüksek getiriye otomatik taşıyan otonom bir yapay zekâ ajanı — siz bir kez kurarsınız, gerisini ajan halleder.

- **Doküman türü:** Ürün açıklaması (product overview) — ürün yöneticisi bakış açısı
- **Tarih:** 3 Haziran 2026
- **Durum:** Çalışan MVP / hackathon demo'su
- **Ağ:** Stellar (Soroban) — getiriler gerçek mainnet'ten okunur, işlemler testnet'te gerçek tx'lerle yürütülür (gerçek para yok)

---

## 1. Yönetici Özeti

İnsanların cüzdanında ve borsasında **boşta bekleyen stablecoin** (USDC) var. Bu para çoğu zaman hiç çalışmıyor; çünkü en iyi getiriyi bulmak, riski değerlendirmek ve fonu sürekli en doğru yere taşımak **tam zamanlı bir iş** ve sıradan kullanıcı için fazla teknik.

**YieldPilot** bu işi bir otonom yapay zekâ ajanına devreder. Kullanıcı parasını bir kez yatırır ve ajana sınırlı bir yetki verir; ajan o andan itibaren piyasayı sürekli tarar, en iyi risk-ayarlı getiriyi seçer ve parayı oraya kendisi taşır. Kullanıcı her hamleyi tek tek onaylamak zorunda kalmaz.

Ürünün özü üç vaatte toplanıyor:

1. **Pasif gelir, sıfır uğraş** — "bir kez ayarla, unut." Ajan 7/24 çalışır.
2. **Güvenli devir** — ajan paranızı **dışarı çıkaramaz**; yalnızca önceden onaylanmış getiri havuzları arasında, günlük harcama limitiyle hareket edebilir. Sunucu ele geçirilse bile fonlar kaçırılamaz.
3. **Şeffaflık** — ajan ne yaptığını, neden yaptığını canlı bir ekranda ve sade bir dille gösterir. Kara kutu değil, izlenebilir bir asistan.

YieldPilot, Base ağında doğmuş ve **ETHGlobal Agentic Ethereum 2025 finalisti** olmuş orijinal **YieldSeeker** konseptinin Stellar ağına taşınmış ve yeniden tasarlanmış hâlidir. Stellar'a taşımanın temel ticari mantığı: Stellar'daki ana lending protokolü olan **Blend, USDC için aylardır ~%8+ getiri** sunuyor — bu, Base/Ethereum tarafındaki benzer protokollerin (%2-5) belirgin üzerinde. Yani "getiri avcısı" tezi burada daha güçlü çalışıyor.

---

## 2. Problem

**Boştaki stablecoin, kaçırılan getiridir.** Bugün on-chain dünyada yüz milyonlarca dolarlık USDC hiçbir getiri üretmeden bekliyor. Bunu çalıştırmak isteyen kullanıcı dört ayrı duvara çarpıyor:

| Engel | Kullanıcının yaşadığı zorluk |
|-------|------------------------------|
| **Karmaşıklık** | Onlarca protokol, sürekli değişen faiz oranları, anlaşılması zor risk parametreleri. Hangi havuz güvenli, hangisi tuzak? |
| **Süreklilik** | En iyi getiri sabit değil; saatlik değişiyor. Bunu elle takip edip parayı taşımak fiilen imkânsız. |
| **Güven** | Otomasyon için çoğu çözüm cüzdanınızın anahtarını ister. "Parayı yönetsin ama çalamasın" garantisini kimse net vermiyor. |
| **Risk körlüğü** | 2026'da Stellar'da yaşanan oracle manipülasyon saldırıları (Blend, YieldBlox) gösterdi ki yüksek getiri her zaman güvenli değil. Sıradan kullanıcı bu riski göremiyor. |

Sonuç: Getiri fırsatı **var**, ama ona ulaşmak için gereken zaman, bilgi ve güven çoğu kişide **yok**.

---

## 3. Çözüm

YieldPilot, kullanıcı ile DeFi getirisi arasındaki bu mesafeyi bir **otonom ajan** ile kapatır. Ürün üç katmandan oluşur:

**1) Sürekli tarayan göz.** Ajan, Stellar üzerindeki getiri kaynaklarını (bugün Blend ve DeFindex; yarın daha fazlası) düzenli olarak tarar ve her havuzun güncel getirisini, büyüklüğünü ve sağlık durumunu okur.

**2) Karar veren beyin.** Her tarama sonrası bir yapay zekâ modeli (Claude), kullanıcının risk toleransına göre en iyi hamleyi seçer. Önce kurallı bir **risk skoru** riskli/sığ/sağlıksız havuzları eler; ardından ajan kalan adaylar arasından en yüksek getiriyi seçer ve kararını **sade bir dille gerekçelendirir** ("Risk-ayarlı en iyi getiri B havuzu, +Δ%. Taşıyorum.").

**3) Uygulayan el.** Karar "taşı" ise, ajan parayı eski havuzdan çeker ve yeni havuza yatırır — gerçek blokzincir işlemleriyle, kullanıcının ek onayı olmadan, ama **önceden çizilmiş güvenlik sınırları içinde**.

Kullanıcı tarafında deneyim son derece sade: cüzdanını bağla → bir kez kur → ajanı izle.

---

## 4. Hedef Kullanıcı

| Persona | Kim | İhtiyaç | YieldPilot'ın cevabı |
|---------|-----|---------|------------------------|
| **"Pasif kazanç isteyen birikimci"** | Elinde stablecoin tutan ama aktif yönetmek istemeyen kullanıcı | "Param çalışsın ama ben uğraşmayayım." | Bir kez kur, ajan sürekli optimize etsin. |
| **"Getiri avcısı ama zamanı yok"** | DeFi'yi bilen, en iyi oranı kovalayan ama 7/24 ekran başında olamayan kullanıcı | "En iyi oranı kaçırmak istemiyorum." | Ajan saatlik fırsatları yakalar, elle takip gerekmez. |
| **"Temkinli yeni başlayan"** | DeFi'ye yeni, riskten çekinen kullanıcı | "Param güvende mi? Kaybeder miyim?" | Drain-korumalı yetki + risk filtresi + şeffaf gerekçe. |
| **(Gelecek) Kurumsal / hazine** | Stablecoin hazinesi yöneten ekipler | "Boştaki nakdi politikayla, denetlenebilir şekilde çalıştırmak." | Kurallı, limitli, izlenebilir otonom yönetim. |

Ortak payda: **"Getiriyi istiyorum ama yönetim yükünü ve güven riskini istemiyorum."**

---

## 5. Değer Önerisi

YieldPilot'ı rakiplerinden ve "elle yapmaktan" ayıran dört temel fayda:

### 🔁 Bir kez kur, ajan çalışsın
Kullanıcı tek seferlik bir kurulum yapar (hesap oluştur, ajana yetki ver, para yatır). Sonrasında hiçbir hamleyi tek tek onaylamak zorunda değildir. Ajan, kullanıcı uyurken de en iyi getiriyi kovalar.

### 🔒 Paranız ajana emanet değil, kurallara emanet
Bu ürünün kalbi. Ajana verilen yetki **sınırlıdır ve zincire kazınmıştır**:
- Ajan parayı **yalnızca önceden onaylı getiri havuzları arasında** taşıyabilir — dışarı, başka bir adrese **gönderemez**.
- **Günlük harcama tavanı** vardır (demoda 5.000 USDC/gün).
- Sunucu veya ajanın anahtarı ele geçirilse bile, saldırgan fonları **çalamaz** — yapabileceği en kötü şey, parayı yine onaylı bir getiri havuzuna koymaktır.

Bu, "tam kontrol asla ajanda değildir" prensibinin ürünleşmiş hâli.

### 🧠 Şeffaf ve açıklanabilir kararlar
Her tarama, her karar ve her işlem **canlı bir akışta** görünür. Ajan neden taşıdığını (veya neden taşımadığını) doğal dille açıklar. Kullanıcı bir kara kutuya değil, **ne yaptığını söyleyen** bir asistana güvenir.

### 🛡️ Yüksek getiri ≠ kör risk
Ajan körlemesine en yüksek oranı seçmez. Bir **risk skoru**; havuzun büyüklüğünü (TVL), doluluk oranını (utilization) ve **oracle sağlığını** değerlendirir. 2026'daki Stellar oracle saldırılarından sonra, sağlıksız işaretlenen havuzlar otomatik elenir. Kullanıcı risk toleransını seçer (temkinli / dengeli / agresif); ajan o çerçevede kalır.

### 💸 Gas/teknik yük gizli
Kullanıcı işlem ücretleri, blokzincir mekaniği, "stroop" gibi teknik detaylarla uğraşmaz. Bunlar arka planda soyutlanır.

---

## 6. Nasıl Çalışır — Kullanıcı Yolculuğu

Kullanıcının gördüğü deneyim, dört adımlık bir kurulum ve sonrasında pasif bir izleme ekranıdır.

**Kurulum (tek seferlik, ~dört adım):**

1. **Cüzdanı bağla** — Kullanıcı Freighter cüzdanını bağlar.
2. **Akıllı hesap oluştur** — Kendisine ait, kişisel bir "akıllı hesap" oluşturulur. (Para bu hesapta durur, ajanda değil.)
3. **Ajana yetki ver** — Ajana, yalnızca getiri havuzlarını yönetebilen, günlük limitli, kısıtlı bir kural tanımlanır. (Drain koruması burada doğar.)
4. **Para yatır & aktive et** — Kullanıcı ne kadar USDC'yi ajana emanet edeceğini seçer ve otonom döngüye devreder.

**Sonrası (otonom):**
- Ajan periyodik olarak (veya talep üzerine) piyasayı tarar.
- En iyi risk-ayarlı havuzu seçer; gerekiyorsa parayı taşır.
- Tüm bunlar **canlı ekranda** akar: hangi havuzlar izleniyor, en iyi getiri ne, en son karar neydi.

**İzleme deneyimi — "Living Network":**
Ürünün ana ekranı, ajanı bir **canlı ağ haritası** olarak gösterir: merkezde ajan, etrafında izlediği getiri havuzları düğümler hâlinde. Tarama yapıldıkça düğümler canlanır, kararlar bir akış şeridinde belirir, en altta "Kaç havuz izleniyor", "En iyi getiri", "Boştaki USDC" gibi anlık metrikler durur. Amaç: otonom bir sistemi **soğuk bir log ekranı** değil, **nabzı atan, izlemesi keyifli** bir şeye dönüştürmek.

---

## 7. Temel Özellikler

| Özellik | Kullanıcıya faydası | Durum |
|---------|---------------------|-------|
| **Otonom getiri taraması** | En iyi oranı sizin yerinize 7/24 kovalar | ✅ Çalışıyor (gerçek mainnet verisi) |
| **Yapay zekâ kararı + sade gerekçe** | Ne yaptığını anlarsınız; kara kutu değil | ✅ Çalışıyor (Claude) |
| **Drain-korumalı yetki** | Ajan paranızı çalamaz; sadece onaylı havuzlara taşır | ✅ Çalışıyor (zincirde kural + günlük limit) |
| **Kişiye özel akıllı hesap** | Her kullanıcının fonu kendi hesabında izole | ✅ Çalışıyor |
| **Risk skoru + oracle filtresi** | Yüksek getiri tuzaklarından korunma | ✅ Çalışıyor |
| **Risk toleransı seçimi** | Temkinli/dengeli/agresif — kontrol sizde | ✅ Çalışıyor |
| **Çoklu protokol** | Tek havuza bağımlı değil; daha çok fırsat | 🟡 Blend + DeFindex aktif; Soroswap/Aquarius/Phoenix "yakında" |
| **Canlı "Living Network" panosu** | Ajanı gerçek zamanlı, anlaşılır şekilde izleme | ✅ Çalışıyor |
| **Gerçek zincir işlemleri** | Demo değil, gerçek tx hash'leri (testnet) | ✅ Çalışıyor |
| **Gas soyutlama** | Teknik ücret yükü kullanıcıdan gizli | ✅ Çalışıyor |

---

## 8. Farklılaşma — Neden YieldPilot?

**"Elle yapmaya" karşı:** İnsan saatlik oran değişimlerini takip edip parayı taşıyamaz; ajan yapar.

**Sıradan getiri toplayıcılarına (yield aggregator) karşı:** Çoğu toplayıcı statik kurallarla çalışır ve **açıklama vermez**. YieldPilot bir yapay zekâ ile karar verir ve kararını **dille gerekçelendirir** — güven ve şeffaflık burada farklılaşır.

**Cüzdan-emanet otomasyonlara karşı:** Birçok otomasyon çözümü fonların kontrolünü ele alır. YieldPilot'ın **drain-korumalı, zincire kazınmış yetki modeli** "para sizde kalır, sadece getiri havuzları arasında hareket eder" garantisi verir.

**Ekosistem zamanlaması:** Stellar'da Blend'in **~%8+ USDC getirisi**, bu ürünün ticari tezini Base/Ethereum'a göre daha güçlü kılıyor. Ayrıca Stellar'ın olgun "akıllı cüzdan / kısıtlı imzacı" altyapısı, güvenli ajan modelini yerli olarak destekliyor.

> **Pazar bağlamı:** Otonom DeFi ajanları 2025-2026'da hackathon ve ticari sahnenin baskın temasıydı (ör. Base üzerinde Giza ARMA gibi otonom stablecoin getiri ajanları milyarlarca dolarlık hacim raporladı). YieldPilot, bu dalganın **Stellar'a getirilmiş, güvenlik-öncelikli** bir yorumudur.

---

## 9. Mevcut Durum (Dürüst Değerlendirme)

YieldPilot şu an **çalışan bir MVP / hackathon demo'su**. Neyin gerçek, neyin henüz simülasyon olduğu konusunda net olmak önemli:

**Gerçek olan:**
- Getiri taraması **gerçek mainnet** Blend ve DeFindex verisini okur (gerçek ~%4-8 USDC oranları).
- Karar gerçek bir yapay zekâ modeliyle (Claude) verilir.
- İşlemler **gerçek Soroban testnet tx'leri** olarak yürütülür (gerçek tx hash'leri, doğrulanabilir).
- Her kullanıcı gerçek bir kişisel akıllı hesap alır; drain-korumalı yetki gerçekten zincirde zorlanır.

**Henüz olmayan (bilinçli kapsam dışı):**
- **Gerçek para yok.** Yürütme testnet'te; mainnet'te gerçek fonla işlem yapılmıyor.
- **Üretim-seviye denetim yok.** Özel, denetlenmiş akıllı kontrat (orkestratör/vault) "üretim yükseltmesi" olarak işaretli.
- **Dar protokol yüzeyi.** Şimdilik ağırlıklı Blend; DeFindex tarama tarafında eklendi.

> **Neden mainnet okuma + testnet yürütme?** Stellar testnet'te tek ve düşük getirili (~%0.05) bir havuz var; bu, demoyu gerçekçilikten uzaklaştırırdı. Bu yüzden ürün **gerçek getirileri mainnet'ten okur**, ama **güvenli şekilde testnet'te yürütür** — kullanıcıya gerçek piyasayı, gerçek para riski olmadan gösterir.

---

## 10. Yol Haritası

| Aşama | Hedef | Ürün değeri |
|-------|-------|-------------|
| **Şimdi (MVP)** | Mainnet tarama + testnet yürütme + güvenli ajan + canlı pano | Konsept kanıtı, demo, güven modeli gösterimi |
| **Yakın dönem** | Daha çok getiri kaynağı (Soroswap, Aquarius, Phoenix) | Daha geniş fırsat yüzeyi, daha iyi çeşitlendirme |
| **Orta dönem** | Mainnet yürütme + denetlenmiş akıllı kontrat (atomik rebalance) | Gerçek parayla, gerçek getiri |
| **Orta dönem** | Güçlendirilmiş risk modeli (oracle + likidite-derinliği + denetim filtreleri) | Daha güvenli otonomi, kurumsal güven |
| **Uzun dönem** | Kullanıcı bildirimleri, performans geçmişi/raporlama, çoklu varlık | Sadakat, güven, kurumsal kullanım |
| **Uzun dönem** | Üçüncü-parti denetim + topluluk fonu (SCF) yolu | Üretime hazırlık, sürdürülebilirlik |

---

## 11. Riskler & Açık Sorular

**Ürün/pazar riskleri:**
- **Dar DeFi yüzeyi:** Stellar'ın toplam DeFi büyüklüğü (~$235M) görece küçük; rebalancing çeşitliliği EVM kadar zengin değil. Fırsat sayısı sınırlı.
- **Oracle/protokol riski:** Yüksek getirili havuzlar saldırıya uğrayabilir (2026'da yaşandı). Risk modelinin sürekli güçlendirilmesi şart — bu bir "kur ve unut" güvenlik kararı değil.
- **Güven eşiği:** Kullanıcıyı "ajan paramı yönetsin" noktasına getirmek bir davranış değişikliği. Şeffaflık ve drain koruması bunun anahtarı, ama eğitim/iletişim gerektirir.

**Olgunluk riskleri:**
- Stellar tarafında hazır bir "ajan araç seti + DeFi aksiyon kütüphanesi" yok; protokol entegrasyonları elle yazılıyor. Bu, yeni kaynak ekleme hızını yavaşlatabilir.
- Üretime geçiş; denetim, özel kontrat ve mainnet imzalama gibi ek mühendislik ve maliyet kalemleri gerektirir.

**Açık ürün soruları:**
- Gelir modeli ne olacak? (performans ücreti / yönetim ücreti / freemium?)
- Hangi getiri kaynakları, hangi sırayla eklenmeli? (TVL mi, getiri mi, güvenlik mi önceliklendirme kriteri?)
- Kullanıcı, ajanın kararlarına ne kadar müdahale edebilmeli? (tam otonom mu, "öner-onayla" modu da olmalı mı?)

---

## 12. Başarı Metrikleri (Öneri)

Ürünün başarısını ölçmek için izlenebilecek temel göstergeler:

- **Aktivasyon:** Cüzdan bağlayan kullanıcıların yüzde kaçı kurulumu tamamlayıp ajanı aktive ediyor?
- **Emanet edilen değer (TVL):** Ajanlara emanet edilen toplam USDC.
- **Kazandırılan getiri:** Ajanın "elle bırakmaya" kıyasla kullanıcıya kazandırdığı ek getiri (baz puan).
- **Otonom hamle sayısı / doğruluğu:** Ajanın yaptığı rebalancing sayısı ve bunların gerçekten daha iyi getiriye taşıyıp taşımadığı.
- **Güven sinyali:** Kullanıcıların ajanı aktif bırakma süresi (retention) ve emanet ettikleri tutarı artırma oranı.
- **Güvenlik:** Sıfır fon kaybı / sıfır drain olayı (en kritik güven metriği).

---

## 13. Özet

YieldPilot, **"boştaki stablecoin'i, güvenli ve şeffaf bir yapay zekâ ajanına emanet edip pasif getiri kazanma"** fikrini Stellar ağında somutlaştıran bir üründür. Değerinin merkezinde üç şey var: **otonomi** (bir kez kur, ajan çalışsın), **güven** (ajan paranızı çalamaz — kurallar zincirde) ve **şeffaflık** (ne yaptığını canlı ve sade dille görürsünüz).

Bugün çalışan bir MVP olarak gerçek piyasa verisini, gerçek bir yapay zekâ kararını ve gerçek zincir işlemlerini (testnet'te) birleştiriyor. Önündeki yol; daha çok getiri kaynağı, mainnet'te gerçek para ve üretim-seviye güvenlik denetimi.

---

*Bu doküman, projenin kod tabanı, fizibilite raporu (`yieldseeker-stellar-fizibilite-raporu.md`), tasarım spec'leri ve çalışan MVP'si incelenerek ürün yöneticisi bakış açısıyla hazırlanmıştır. Teknik mimari detayları için `docs/superpowers/` altındaki spec ve plan dosyalarına bakınız.*
