# Vigil: rakip analizi

> **Güncel tablo başvuruda:** `submission.md` → "How Vigil relates to existing work". Bu dosya 2026-11-01'deki araştırma; sonradan bulunanlar yalnızca başvuruda var: Stenion (açık kaynak, Blend dahil 5 market için 0–100 güvenlik skoru, admin-key faktörü), Tsuna (OZ smart account üzerinde agent vault limitleri), Credora + Newton (EVM'de rating'e bağlı işlem engelleme), Policywright.

**Tarih:** 2026-11-01. Aşağıdaki tüm URL'lere bu tarihte erişildi.
**Yöntem:**
- SCF submission sayfaları, proje siteleri ve dokümanlar okundu.
- GitHub commit geçmişlerine `gh api` ile bakıldı.
- Halka açık API endpoint'leri `curl` ile sorgulandı.
- Blend mainnet'i read-only okundu ve simüle edildi; tx gönderilmedi.
- Stellar Ecosystem DB snapshot'ı kullanıldı (lumenloop/stellar-ecosystem-db, commit `efaa048`, 2026-10-30). Arama mekanizma kelimeleriyle yapıldı: risk, score, rating, monitor, alert, oracle, insur, audit, firewall, guard, health factor ve diğerleri. Toplam 172 eşleşme çıktı.
- EVM oyuncuları (Credora, Chaos, Gauntlet, Exponential, DeFi Safety, LlamaRisk, Block Analitica, Sherlock/Cantina, Forta) için tek bir paralel araştırma turu yapıldı. Bu satırlar † ile işaretli. Ben yalnızca Hypernative tarihini ve Riskon'u kendim yeniden doğruladım.

> **SCF tutarları hakkında not.** SCF proje sayfasındaki "Total awarded" ile DB'deki `awarded_total` çoğu zaman farklı. Örnekler:
> - Oracle Shield: $120K / $36K
> - Orion: $122.2K / $73,333
> - Hoops: $150K / $116,667
>
> DB değeri **ödenmiş tranche'lar** gibi görünüyor. Bu bir çıkarım, doğrulanmadı. Tabloda ikisi de "sayfa / DB" biçiminde verildi.

---

## 0. Önce bilmen gerekenler

1. **Blend için havuz seviyesinde rating zaten var.** Kanıtlar:
   - **Alterscope** (SCF #24 + #26, $137.6K) Stellar mainnet'te canlı. Blend lending havuzlarını kapsıyor ve agent'lara yönelik bir API ile MCP server sunuyor. Dokümanında "pre-deposit check" tarifi var: risk bandı kullanıcının toleransını aşarsa deposit reddediliyor.
   - **Riskon** (SCF'siz, küçük bir proje), Fixed V2 ve YieldBlox V2 havuzlarına bugün A–F notu veren canlı bir API yayınlıyor.
   - Bu yüzden taslaktaki **"No pool-level, on-chain-enforceable rating exists on Stellar"** cümlesinin ilk yarısı yanlış ve çıkarılmalı.
2. **Bu aramada şunları bulamadım:**
   - Rating'i Soroban'a yazan ve **kullanıcının smart account'unda** zorlayan bir sistem.
   - DeFindex vault'larını puanlayan bir sistem.

   Bu bir arama sonucu, mutlak bir iddia değil. Başvuruda "first/only" olarak kullanılmamalı.
3. **Alterscope'un public OpenAPI spec'inde** Stellar smart-wallet'larla çalışan "autonomous strategies" endpoint'leri var. Yapıları:
   - `register_session` / `revoke_session` çağrıları ve `policyJson.assetCaps[...].max_per_tx` limiti.
   - Blend'e supply yapan bir autopilot.
   - Sermaye akışı `AUTONOMY_SHADOW_MODE_ENABLED` bayrağıyla kapalı.

   Bu yapı hem YieldPilot hem de Vigil'in tüketici hikâyesiyle örtüşüyor.
4. **Blend'in kendi on-chain gate'i zaten var.** Pool status `Frozen` olunca deposit kapanıyor. Ancak bu gate tembel çalışıyor:
   - YieldBlox V2 bugün `status 3` (On_Ice) durumunda ve backstop Q4W %97.75.
   - `update_status()` simülasyonu `5` (Frozen) döndürdü. Yani biri çağırana kadar deposit'ler açık kalıyor.
   - Riskon aynı havuza **"A"** veriyor.

---

## 1. Tablo

Kısaltmalar:
- **Seviye:** P = pool/market/vault seviyesi, A = varlık veya varlık çifti, Pr = protokol, W = cüzdan, adres ya da işlem.
- **Enforcement:** sonuç on-chain bir kararı bloke ediyor mu.

### 1a. Stellar-native ve SCF DB'den çıkanlar

| Proje | Seviye | Stellar kapsamı (Blend / DeFindex) | On-chain enforcement | Açık kaynak | Durum (kanıt tarihi) | SCF fonu (sayfa / DB) |
|---|---|---|---|---|---|---|
| **Alterscope** (Solity Network UG) | P (Blend "lending pool metrics", fırsat başına risk bandı 1–5 ve faktör skorları), A (oracle), Pr | **Canlı.** Blend connector: 24 fırsat, ~$170M TVL. Aquarius ve SDEX de var. **DeFindex yok.** | Rating için yok ("never holds assets, submits transactions"). Smart-wallet autopilot spec'te var ama shadow-mode'da. | **Hayır.** Kod public değil. Metodoloji dokümante, ağırlıklar "calibrated internally" diye gizli. | **Aktif.** `blend` connector `last_success` 2026-11-01T14:21Z. Yeni MD Eylül 2026'da geldi. Docs portalı 2026-05-02'de açıldı. | #24 $38.4K + #26 $99.2K = **$137.6K** / $137.6K |
| **Riskon** (mericcintosun/riskon) | **P**: 2 Blend V2 havuzu, A–F, 4 faktör | **Canlı.** Fixed V2 = "B" (47), YieldBlox V2 = **"A"** (30). DeFindex yok. | Havuz rating'i için yok. Testnet kontratı yalnızca cüzdan risk tier'ı tutuyor (repo açıklamasına göre). | Kod public, **lisans dosyası yok** | Aktif. Son push 2026-10-12, pool-rating commit'leri 2026-07-15/16. API 2026-11-01'de yanıt verdi. | Bulunamadı ("SCF 2024 Q1" iddiası doğrulanamadı) |
| **Hoops Finance** | P: AMM havuz analitiği, "risk-assessed vaults" (metodoloji yayınlanmamış) | Aqua, Comet, Soroswap ve Phoenix adapter'ları var. "Blend weighted pools and backstop" deliverable'ı #30 sayfasında "Ongoing". | Strateji kontratları (router/account) var, rating enforcement yok. | Contracts repo public, lisans belirtilmemiş | Yavaşlamış. Son commit 2026-02-11, son blog 2025-07-28. FlashPool ve Vaults hâlâ "TESTNET". | #29 $50K + #30 $100K = $150K / $116,667 |
| **DD** (Webacy) | Stellar'da W ve token. EVM'de vault rating'leri (0–100, A+–F) var ama **Stellar'da yok**. | Stellar adres ve token riski **beta**. Soroban submission'da kapsam dışı: "Maybe in the future". | Yok ("are not smart contracts themselves") | Hayır | Aktif (vault docs ekran görüntüleri 2026-04). Stellar ürününün canlıya çıktığı doğrulanamadı. | #38 $150K / $150K |
| **Stellar Oracle Shield** (Sun Zu Lab) | **A**: `(base, quote)` çifti için 0–100 skor → Healthy/Degraded/Unsafe | Testnet kontratı `CCMSDP…YE7P`. Blend ve DeFindex adıyla geçmiyor. | **Evet, kısmen.** Protokoller `get_status` sorguluyor, kararı entegre eden protokol veriyor. Tek operator rolü var; 2-of-3 quorum ise plan aşamasında. | **Apache-2.0** | Aktif. v0.1.3 2026-08-26'da çıktı, son commit 2026-09-11. Mainnet README'de yok, oysa T3 tarihi 2026-09-11'di. | #43 $120K / $36K |
| **Orion** (lightgatehq) | **W**: pozisyon, health factor, backstop Q4W maruziyeti | Mainnet'te canlı: Blend, Aquarius, Soroswap (FxDAO sayfada geçiyor). DeFindex yok. | Yok, read-only API | Adapter'lar Apache-2.0 (`lidapters`) | Aktif. Changelog 2026-09-24, repo 2026-10-20. Ücretsiz, 60 rpm. | #41 $122.2K / $73,333 |
| **DeRisk** (Carmine) | Kredi ve protokol seviyesinde erken uyarı | Stellar tarafı yalnızca bir Futurenet event scraper | Yok | Repo public | **Dormant.** `derisk-stellar-events` son commit 2023-11-30. Site 2026-11-01'de timeout verdi. | #20 $50K / $50K |
| **Latch** (3000-Labs) | Risk ürünü değil. C-address onboarding ve OZ smart account cüzdanı (policy'li). | OZ smart account altyapısı. RiskGate'i barındırabilecek bir cüzdan. | Policy altyapısı var, risk verisi yok | Repo public, lisans görünmedi | Son commit 2026-05-15 | #41 $120K / $72K |
| **Hypernative** | W/kontrat: kullanıcının kurduğu izleme. Rating değil. | **Evet.** SDF tutorial'ı (2026-07-16), Blend havuzunda `get_reserve()` okuyup utilization alarmı kuruyor. | Alarm aksiyonları arasında "contract invocations to run onchain events" var. Stellar'da otomatik pause doğrulanamadı. | Hayır | Aktif (2026-07-16) | #26 $50K (Activation) |
| **Blockaid** | W/işlem/token/dApp | Freighter ve Lobstr işlem taraması. YieldBlox sonrası forensik yaptı (2026-05-20). | Cüzdan UI'ında uyarı veya blok, kontrat seviyesinde değil | Hayır | Aktif (2026-05-20) | SCF ödülü bulunamadı (SDF "partnership") |
| **Bluechip** | **A**: stablecoin harf notları (SMIDGE) | Stellar cüzdan rating aracı. USDC "B+", CETES "B+". | Yok. Sayfada on-chain yayın geçmiyor. | Metodoloji public, kod belirtilmemiş | #44 ödüllü. Ayrıca aktivite kontrol edilmedi. | #44 $136.5K / $136.5K |
| **Dig** | Token risk bayrakları, alarmlar, protokol metrikleri | Blend, Aquarius, Soroswap ve DeFindex analitiği | Yok | MIT (`dig-stellar`) | Aktif (push 2026-10-30) | #43 $75K / $75K |
| **Tezoro** | Kendi içinde market skorlaması. "Security Layer" Ethereum'da canlı, Stellar'da değil. | Blend v2 adapter'lı vault | Belirtilmemiş | Stellar repo public, lisans yok | Stellar repo'da son push 2026-04-23. tezoro.io artık "Warren" markasını gösteriyor. | #42 $143.8K / $143.8K |
| **Policywright** / **Gateway.fm OZ Accounts Policy Builder** | Statik least-privilege OZ policy üretimi | OZ smart account | Policy evet, **risk verisi yok** | Policywright repo public | #44 | Policywright: DB $33K (sayfada $55K, alt ajanın bulgusu, doğrulamadım). Gateway.fm: $98K. |
| **CertiK** #25, **CyVers** #26, **Merkle Science** #41, **Scorechain** #36, **Range** | W/adres/işlem, KYT/AML | Stellar adres ve işlem tarafı | Yok | Hayır | Stellar ürünlerinin çıktığı doğrulanamadı | #25 $50K, #26 ~$50K, #41 DB $82.8K, #36 $85K, Range #34 doğrulanamadı |

### 1b. Genel ve EVM oyuncuları (†: tek araştırma turu, yeniden doğrulanmadı)

| Proje | Seviye | Stellar kapsamı | On-chain enforcement | Açık kaynak | Durum | SCF |
|---|---|---|---|---|---|---|
| **Credora** (artık "Credora by RedStone") † | P/vault (Morpho market'ları vault rating'ine topluyor), A | **Yok.** RedStone price feed'leri 2026-03-04'ten beri Stellar'da; "Blend… preparing to integrate RedStone feeds". Credora rating'i Stellar'da yok. Credora–Euler entegrasyonu bulunamadı. | Morpho'da yalnızca UI'da (curator onayıyla). On-chain risk feed bulunamadı. | Metodoloji public, kod değil | Aktif (2026-03) | Yok |
| **Chaos Labs** (Edge Risk Oracles) † | Market ve parametre seviyesi | Yok | **Evet**: Aave'de parametreleri on-chain push ediyor | Hayır | 2026-04-06'da Aave'den ayrıldı | Yok |
| **Gauntlet** † | Market parametreleri, curated vault | Yok | Governance ve curator rolü üzerinden | Hayır | Aktif (~2026-04) | Yok |
| **Exponential.fi** † | **P** (A–F) | Blend için not yok. DefiLlama Blend sayfasında grade görünmüyor. | Yok | Hayır | exponential.fi → yo.xyz/risk'e yönleniyor (308). Retail ürün 2025-09-20'de kapandı. | Yok |
| **DeFi Safety** † | Pr (process quality) | Yok | Yok | Kriterler public | Danışmanlığa döndü | Yok |
| **LlamaRisk** † | A/market | Yok | Governance üzerinden | Raporlar public | Aktif (2026-07) | Yok |
| **Block Analitica** † | Market/vault | Yok | Curator rolü üzerinden | Hayır | 2026 aktivitesi doğrulanamadı | Yok |
| **Sherlock / Spearbit-Cantina** † | Audit; izleme ürünü yok | Cantina Audit Bank'te onaylı; Aquarius Soroban yarışmasını yürüttü. Soroban izleme ürünü yok. | — | — | — | Audit Bank (ödül değil) |
| **Forta Firewall** † | İşlem | Yok (EVM rollup'ları) | Sequencer seviyesinde | Kısmen | 2025 | Yok |

### 1c. Blend ve DeFindex'in kendi araçları

| Kaynak | Ne yapıyor | Rating / verified list? |
|---|---|---|
| Blend pool status (on-chain) | **Pool seviyesi, on-chain.** `update_status()` herkese açık. Q4W ve `met_threshold`'a göre status 3 (On_Ice: borrow kapalı) ya da 5 (Frozen: borrow ve **deposit** kapalı) atıyor. | Yalnızca ikili durum, skor yok. **Tembel çalışıyor:** YieldBlox V2'de Q4W %97.75 iken status hâlâ 3. Simülasyon `5` döndürüyor. |
| blend-ui (Script3) | Status banner'ları (On Ice, Frozen, oracle error). `.env.production`'da **tek bir** `NEXT_PUBLIC_BLOCKED_POOLS` (`CBVOPI6…AKO7`). Varsayılan havuz listesi `MAINNET_V2_REWARD_ZONE` (4 havuz). Kullanıcı kendi "tracked pools" listesini tutuyor. | Numerik risk skoru ya da "verified pools" listesi yok. Yalnızca blok listesi ve reward-zone varsayılanı var. |
| Blend docs "Choosing Pools" | Kullanıcıya bir kontrol listesi veriyor: backstop büyüklüğü, Q4W, collateral kalitesi, risk parametreleri, oracle güvenilirliği, admin güveni. | Değerlendirme kullanıcıya bırakılmış. **Vigil'in otomatikleştirdiği liste bu.** |
| DeFindex (defindex-io / PaltaLabs) | Whitelist'li stratejiler. Manager ve Emergency Manager stratejiyi `pause` / `rescue` edebiliyor ("in collaboration with chain analysis tools"). Withdraw her zaman açık. defindex.io/strategies sayfasında Strategy, Type, Asset, TVL ve APY sütunları var. | **Risk skoru yok.** Pause ve rescue tetikleyicisi olarak Vigil'in doğal tüketicisi. Hiçbir LOI yok. |

---

## 2. En yakın 5 rakip

### 1) Alterscope — en büyük tehdit
- **Örtüşme:**
  - SCF tarafından iki kez fonlanmış, Stellar'da Blend'i bugün canlı kapsayan bir risk-veri platformu.
  - Hedef kitlesinde açıkça "automated strategies and agents" var. MCP server, webhook ve REST sunuyor.
  - Dokümanındaki "Score a vault before depositing" tarifi, risk bandı toleransı aşınca deposit'i reddeden bir agent kodu. Bu, Vigil'in off-chain yarısının aynısı.
  - Spec'teki Stellar autonomous-strategy endpoint'leri (smart-wallet session, `max_per_tx` cap, Blend autopilot, `STALE_ORACLE` ile fail-closed) YieldPilot'un modeline çok yakın.
- **Dürüst fark:**
  - **Kapalı kaynak ve ücretli** (Free, Analyst, Team, Enterprise). Rating'ler on-chain yayınlanmıyor; enforcement yok, karar "your strategy decides".
  - Blend derinliği docs'ta "Lending pool metrics" olarak geçiyor. En derin katman Morpho; oracle sınıflandırması şimdilik "Morpho-style Chainlink adapters" ile sınırlı.
  - `GET /v2/pool/CCCCIQ…/risk-scores` (YieldBlox V2) `no_risk_score_coverage` döndü. Not: ID formatı farklı olabilir.
  - DeFindex kapsanmıyor.
  - Bugün gözlenen veri kalitesi sorunları: yield cache ~13 saat bayat (`cache_age 46702`), Aquarius ortalama APY'si %11,626 gibi saçma bir değer, `data-manifest` hata veriyor.
- **Başvuru için:** Bu fark "biz olmayanı yapıyoruz" diye değil, "**açık ve on-chain olanı** yapıyoruz" diye anlatılmalı.

### 2) Riskon — Blend'de havuz seviyesi rating'i zaten yayınlıyor
- **Örtüşme:** Blend V2 havuzlarına A–F notu veren ve JSON API sunan canlı bir site. "Pool-level rating for Blend exists" itirazının somut kanıtı bu.
- **Dürüst fark:**
  - Yalnızca 2 havuz ve 4 faktör: utilization 35%, collateral factor 25%, HHI 25%, depth 15%.
  - Oracle kaynağı, backstop ve Q4W, pool status ya da collateral piyasa derinliği **yok**.
  - Bunun sonucu: on-chain status'u On_Ice olan, Q4W'si %97.75 olan ve `update_status()` simülasyonu Frozen döndüren YieldBlox V2'ye **"A"** veriyor, Fixed V2'ye "B".
  - Lisans yok, 4 yıldız, SCF fonu yok, on-chain yayın yok.
- **Başvuru için:**
  - Zayıflatan bir rakip değil, ama "ilk" iddiasını öldürüyor.
  - "Utilization/TVL tabanlı skorlar donmuş havuzu güvenli gösteriyor" argümanının kamusal bir örneği. Bizim YieldPilot `/api/scan` örneğimizle aynı hata.

### 3) Stellar Oracle Shield (Sun Zu Lab, SCF #43)
- **Örtüşme:** Mimari olarak en yakın proje.
  - Bir operator skoru Soroban kontratına yazıyor.
  - Staleness kontrolü var (varsayılan 3,600 s).
  - Dokümanı tüketicilere fail-closed davranmayı öneriyor.
  - Rust client crate'i yayında.
- **Fark:**
  - Varlık çifti seviyesinde ve protokol geliştiricisine yönelik. Vigil havuz ve vault seviyesinde, depositor'ın smart account'una yönelik.
  - Oracle Shield'de enforcement'ı protokol kendi kontratında yazıyor. Vigil'de kullanıcı OZ policy'siyle yapıyor.
  - Bugün testnet'te ve tek operator'lü. Mainnet ve 2-of-3 henüz yok.
- **Reviewer'ın soracağı:** "Oracle Shield'in kontratına neden pool anahtarı eklemiyorsunuz?" Cevap hazır olmalı:
  - Havuz rating'inin girdileri oracle sağlığından fazlası: backstop, status, collateral parametreleri, admin.
  - Tüketici tarafı farklı: protokol değil, kullanıcının policy'si.
  - Vigil, collateral çiftleri için Oracle Shield'in `get_status`'ünü girdi olarak okuyacak.

### 4) Hypernative (SCF #26)
- **Örtüşme:**
  - SDF'nin kendi tutorial'ı Blend havuzunda `get_reserve()` okuyup utilization alarmı kurmayı gösteriyor.
  - Stellar için "ecosystem package" kapsamında, erişim ağ tarafından sponsorlanıyor (alt ajanın bulgusu).
  - Alarm aksiyonları arasında on-chain kontrat çağrısı var.
- **Fark:**
  - Yayınlanan bir rating değil, her müşterinin kendi kurduğu izleme.
  - Kapalı kaynak. Sonuç kullanıcının hesabında zorlanmıyor.
  - Stellar'da otomatik pause doğrulanamadı.
- **Başvuru için:** Rakip değil, kanal. Vigil'in rating düşüşü bir Hypernative alarm koşulu olabilir.

### 5) DD / Webacy (SCF #38)
- **Örtüşme:** EVM'de olgun bir vault rating ürünü var. Çıktıları:
  - 0–100 skor ve A+–F notu
  - `listing_verdict`
  - `withdrawal_state`
  - ~20 alt skor ve oracle weakest-link modeli

  DeFindex vault'larına uyarlanması teknik olarak kısa iş. Ekip Stellar'da zaten SCF fonlu.
- **Fark (bugün):**
  - Stellar ürünü yalnızca adres ve token riski, beta. Vault kapsamı 6 EVM zinciri; Stellar yok.
  - Submission'da Soroban açıkça kapsam dışı.
  - Off-chain ve kapalı.
- **Risk:** Vigil'in T1–T2 penceresinde Webacy'nin vault rating'lerini Stellar'a taşıma ihtimali gerçek ama kanıtlanmış değil.

### Ayrıca: Blend'in kendi pool status'u (bir "proje" değil, ama en güçlü itiraz)
- **Durum:** Pool seviyesinde zaten on-chain bir deposit gate var (Frozen). Vigil'in neden gerekli olduğunu üç dürüst cevap açıklıyor:
  1. Status yalnızca backstop Q4W ve eşiğe bakıyor. Oracle ve collateral yapılandırmasına bakmıyor; 22 Şubat 2026'daki YieldBlox kaybı bu sınıftandı (BlockSec ve Halborn'a göre pool konfigürasyon hatası).
  2. Status tembel. YieldBlox V2'de kimse `update_status()` çağırmadığı için deposit'ler hâlâ açık.
  3. Kullanıcıya özgü eşik yok.
- **Uyarı:** (2) bir keeper ile çözülebilir. Vigil bunu kendi değeri olarak satmamalı; isterse tek bir keeper deliverable'ı olarak eklemeli.

---

## 3. Positioning paragrafı (İngilizce, 148 kelime, yapıştırmaya hazır)

> Stellar already has off-chain risk data for Blend: Alterscope (SCF #24/#26) serves risk reads for Blend lending markets through an API, Riskon publishes letter grades for two Blend V2 pools, and Hypernative supports custom Blend monitors. Blend itself gates deposits on-chain through pool status, which follows backstop withdrawal queues. Vigil adds three things. It rates every Blend V2 pool and DeFindex vault from pool configuration: the oracle source behind each collateral, backstop size and queue, pool status and reserve parameters. It publishes signed ratings to a Soroban RiskRegistry from an M-of-N publisher set. And a RiskGate policy lets an OpenZeppelin smart account refuse new deposits when a rating drops or goes stale, while withdrawals always stay open. Vigil is designed to take Stellar Oracle Shield (SCF #43) pair-health scores and Blend's own status as inputs. Its users are wallets, DeFindex vault managers and agents, starting with our YieldPilot.

**Not:**
- "first", "only" ve "no existing" bilerek kullanılmadı.
- "DeFindex vault" rating'i, vault'un stratejilerinin altındaki Blend havuzlarından türetilecek. Bu metodoloji başvuruda yazılı olmalı.
- Oracle Shield bugün yalnızca testnet'te. "is designed to take" ifadesi bu yüzden seçildi.

---

## 4. Doğrulayamadığım iddialar

1. **Alterscope Blend skorları:** Blend fırsatlarının gerçekten risk bandı veya faktör skoru taşıyıp taşımadığını göremedim.
   - Neden: `/v2/yield/opportunities` API key istiyor. `/v2/factors/opportunity/…` `catalog_unavailable` döndü. Hesap açmadım.
   - Ana sayfadaki "Blend USDC reserve … elevated" satırı "illustrative" diye etiketli.
2. **Alterscope autonomous strategies:** Stellar endpoint'leri sadece OpenAPI spec'inde görüldü. Canlı olup olmadıklarını, hangi smart-wallet kontratını kullandıklarını (OZ mu, kendi kontratları mı) ve hangi Blend havuzuna supply yapacaklarını doğrulayamadım. `GET /v2/autonomous-strategies` auth istiyor.
3. **Alterscope kimlik eşlemesi:** `risk-scores` sorgusundaki `no_risk_score_coverage` sonucunun gerçekten "kapsam yok" anlamına mı geldiğini, yoksa Alterscope'un Blend havuzları için farklı bir ID formatı mı kullandığını bilmiyorum.
4. **Riskon:** "Selected for SCF 2024 Q1" iddiası ve testnet kontratının yalnızca cüzdan tier'ı tuttuğu bilgisi alt ajanın bulgusu, ben kontratı okumadım.
5. **Hypernative:** SCF #26 ödülünün neyi kapsadığı (sayfada deliverable yok) ve Stellar'da otomatik on-chain yanıtın çalışıp çalışmadığı.
6. **Hypernative erişimi:** Stellar erişiminin "ecosystem package" ile sponsorlandığı bilgisi (2024 tarihli Alchemy yazısı, alt ajanın bulgusu).
7. **Oracle Shield mainnet:** T3 deliverable'ı (mainnet, 2-of-3 quorum, isimli protokol entegrasyonu). Tarihi 2026-09-11'di; README'de mainnet yok, gecikmiş görünüyor ama SCF'den teyit yok.
8. **Webacy:** Stellar API'sinin beta'dan çıkıp çıkmadığı ve "≥2 Stellar protocol partners" hedefine ulaşılıp ulaşılmadığı.
9. **Hoops:** "Risk-assessed vaults" ifadesinin arkasında bir skor olup olmadığı ve #30'daki "Blend weighted pools and backstop" deliverable'ının bitip bitmediği. app.hoops.finance `dashboard-ui-dev.hoops.fi`'ye yönleniyor.
10. **Fon farkları:** DB `awarded_total` ile SCF sayfası arasındaki farkların anlamı (ödenmiş tranche olduğu çıkarımı). Policywright $55K ve Merkle Science $138K değerleri alt ajanın bulgusu.
11. **† satırları (EVM):** Credora–Euler entegrasyonu, Chaos Labs'in Aave'den ayrılış koşulları, Exponential'ın kapanış ifadesi (sayfa bloklu, sadece search snippet), Block Analitica'nın 2026 aktivitesi.
12. **Diğer SCF projeleri:** CertiK, CyVers, Merkle Science ve Range'in Stellar ürünlerinin canlıya çıkıp çıkmadığı; Range'in #34 ödülü; Untangled Credio'nun Stellar mainnet'te olup olmadığı.
13. **Aktivitesine bakmadığım adjacent projeler:** Blip (#28, kontrat izleme), Solarkraft (#24/#29, runtime monitoring), SAFU (#44, cüzdan sigorta havuzu), Trustline (#44, kurumsal erişim kontrolü ve sigorta), Cushion (#41), One Click (#32, "AI-powered risk assessments"), Sentora ve Upshift'in Stellar vault'ları. Hiçbirinin havuz rating'i yayınladığına dair bir işaret görmedim, ama derinlemesine incelemedim.
14. **X (Twitter):** Gönderileri okunamadı (HTTP 402). "Son aktivite" sütunu GitHub, blog ve API kanıtına dayanıyor.

---

## Kaynaklar (hepsine 2026-11-01'de erişildi)

**Alterscope**
- https://www.alterscope.org/ · https://www.alterscope.org/agents · https://www.alterscope.org/curators · https://www.alterscope.org/about · https://www.alterscope.org/insights
- https://docs.alterscope.org/coverage · https://docs.alterscope.org/trust/methodology/pool-risk-scores · https://docs.alterscope.org/trust/methodology/limitations · https://docs.alterscope.org/recipes/score-vault-before-deposit · https://docs.alterscope.org/pricing · https://docs.alterscope.org/changelog · https://docs.alterscope.org/openapi-public.yaml
- https://api.alterscope.org/v2/yield/protocols · https://api.alterscope.org/v2/yield/connectors/status · https://api.alterscope.org/v2/yield/chains · https://api.alterscope.org/v2/pool/CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS/risk-scores · https://api.alterscope.org/v2/data-manifest
- https://communityfund.stellar.org/submissions/recam5gal7vWgPt9A · https://communityfund.stellar.org/submissions/rec9bGg7CKnZUW3tG

**Riskon:** https://github.com/mericcintosun/riskon · https://riskon.vercel.app/api/pools/ratings

**Hoops:** https://communityfund.stellar.org/submissions/rechiZHwFanNF1nnI · https://communityfund.stellar.org/submissions/recYojyYEHFK01KlM · https://hoops.fi/ · https://github.com/hoops-finance/contracts

**DD / Webacy:** https://communityfund.stellar.org/submissions/recpuas3WNh58u0RB · https://docs.webacy.com/essentials/stellar.md · https://docs.webacy.com/vault-ratings.md · https://docs.webacy.com/vault-risk-intelligence

**Stellar Oracle Shield:** https://communityfund.stellar.org/submissions/recQ4g4OKMNXnHQX4 · https://github.com/sunzu-lab/stellar-oracle-shield · https://www.sunzulab.com

**Orion:** https://communityfund.stellar.org/submissions/recPt6cTMzx8XmiNj · https://orionhq.run/changelog · https://orionhq.run/pricing · https://github.com/lightgatehq

**DeRisk:** https://communityfund.stellar.org/submissions/recWVVLF0ufdI0y0Z · https://github.com/CarmineOptions/derisk-stellar-events

**Latch:** https://communityfund.stellar.org/submissions/recUrEbIUnLVTIbra · https://github.com/3000-Labs/latch

**Bluechip:** https://communityfund.stellar.org/submissions/recbX8pYYdcArFEPe

**Tezoro:** https://communityfund.stellar.org/submissions/recGl3bJHP5TkDOj7 · https://github.com/tezoroproject/tezoro-yield-aggregator-stellar

**Dig:** https://github.com/mael-wnb/dig-stellar · https://getdig.ai

**Gateway.fm:** https://communityfund.stellar.org/submissions/recTFz7yIm9fWFHSx

**Hypernative:** https://stellar.org/blog/developers/monitoring-stellar-with-hypernative (yayın 2026-07-16) · https://communityfund.stellar.org/project/hypernative-ik0 †

**Blockaid:** https://blockaid.io/blog/73-quarantined-how-blockaid-and-stellar-validators-contained-a-10m-price-manipulation-attack † · https://blockaid.io/blog/stellar-bolsters-ecosystem-wide-security-with-blockaid †

**Credora / RedStone:** https://www.redstone.finance/blog/stellar-finally-gets-the-oracle-infrastructure-it-deserves/ † · https://forum.morpho.org/t/credora-network-risk-ratings-on-morpho/1652 † · https://docs.redstone.finance/docs/redstone-credora/faq/ †

**Chaos Labs:** https://www.theblock.co/news/defi/2026-04-06-top-aave-risk-manager-chaos-labs-exits-amid-governance-dispute-396458 † · https://chaoslabs.xyz/posts/aave-integrates-chaos-labs-edge-risk-oracles †

**Exponential:** https://defillama.com/yields/pool/ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf † · https://help.exponential.fi/en/articles/12084709-how-to-transition-your-exponential-account-by-sept-20-2025 †

**Audit Bank:** https://stellar.gitbook.io/scf-handbook/supporting-programs/audit-bank/official-rules † · https://code4rena.com/audits/2025-02-blend-v2-audit-certora-formal-verification †

**Blend**
- https://docs.blend.capital/users/choosing-pools · https://docs.blend.capital/tech-docs/core-contracts/lending-pool/pool-management (github.com/blend-capital/docs-v2 @2026-10-07)
- https://github.com/blend-capital/blend-ui (@2026-10-26: `.env.production`, `src/utils/version.ts`, `src/components/pool/PoolStatusBanner.tsx`)
- Mainnet okuması ve `update_status` simülasyonu (tx gönderilmedi): `mainnet.sorobanrpc.com`, 2026-11-01T14:40Z
  - Fixed V2: status 3, Q4W %6.59
  - YieldBlox V2: status 3, Q4W %97.75, simülasyon sonucu → 5

**DeFindex:** https://docs.defindex.io/advanced-documentation/risks-and-audits.md · https://docs.defindex.io/strategies/blend-autocompound.md · https://www.defindex.io/strategies

**YieldBlox olayı:** https://blocksec.com/blog/yieldblox-dao-incident-on-stellar-oracle-misconfiguration-enabled-a-10m-drain · https://www.halborn.com/blog/post/explained-the-yieldblox-hack-february-2026

**Ecosystem DB:** https://github.com/lumenloop/stellar-ecosystem-db (yerel snapshot `efaa048`, 2026-10-30)
