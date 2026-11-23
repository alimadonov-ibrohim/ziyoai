# ZiyoAI — backend + Gemini API

`ziyoai.html` — oldingi yagona fayl interfeys. Endi u `server.js` orqali ishlaydi:
**API kalit brauzerga yuborilmaydi**, faqat serverda saqlanadi.

## 1. Kalit olish
1. https://aistudio.google.com/apikey ga kiring.
2. **Create API key** bosing (Google Cloud project tanlang).
3. Kalitni nusxalang (`AIza...` bilan boshlanadi).

## 2. Kalitni qo'yish
`.env.example` ni `.env` ga nusxalab, kalitni yozing:

```env
GEMINI_API_KEY=AIzaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
PORT=3000
```

`.env` fayli `.gitignore` ga qo'shilgan — hech qaerga yuborilmaydi.

## 3. Ishga tushirish
```bash
npm start
```
Keyin brauzerda: **http://localhost:3000**

> `ziyoai.html` ni to'g'ridan-to'g'ri (file://) ochsangiz, eski rejim ishlaydi —
> kalitni Sozlamalar → API Keys ichiga qo'lishingiz kerak bo'ladi.
> Haqiqiy backend uchun faqat `http://localhost:3000` manzilini ishlating.

> **Vercel uchun:** statik fayllar `public/` papkasidan olinadi. `ziyoai.html` yoki
> `google-callback.html` ni o'zgartirgandan keyin `npm run sync:public` bajaring
> (yoki ularni qo'lda `public/` ga nusxalang), keyin commit qiling.

## 4. Nima qiladi
- `GET /api/health` — server va kalit holati.
- `GET /api/models` — **API'dan jonli model ro'yxatini oladi** (har 10 daqiqada keshlanadi).
  Faqat matn yaratadigan (`generateContent`) modellar qoldiriladi; bepul modellar
  birinchi o'ringa qo'yilib, yonida **FREE tier** yozuvi chiqadi.
- `POST /api/chat` — `streamGenerateContent` orqali oqimli javob (SSE).
  Xabar uzilganda yoki foydalanuvchi to'xtatganda server ham ulanishni uzadi.

Modellar nomlari (hujjatlar bo'yicha, kalit ko'rishi mumkin bo'lganlari avtomatik chiqadi):

| Model kodi | Nom | Tier |
|---|---|---|
| `gemini-3.5-flash-lite` | Gemini 3.5 Flash-Lite | Free |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash-Lite | Free |
| `gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash-Lite Preview | Free |
| `gemini-3.6-flash` | Gemini 3.6 Flash | Free |
| `gemini-3.8-flash` | Gemini 3.8 Flash | Free |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview | Free |
| `gemini-2.5-flash` | Gemini 2.5 Flash | Free (eshkirakilar uchun) |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash-Lite | Free |
| `gemini-2.0-flash` | Gemini 2.0 Flash | Free |
| `gemini-2.0-flash-lite` | Gemini 2.0 Flash-Lite | Free |
| `gemini-flash-latest` / `gemini-flash-lite-latest` | eng yangi Flash aliaslari | Free |
| `gemini-4-carbon`, `gemini-4-neon`, `gemini-4-hydrogen`, `gemini-4-argon` | Gemini 4 | Pullik bo'lishi mumkin |

> **Eslatma:** Gemini API modellari ro'yxati *tier* (bepul/pullik) ma'lumotini
> o'zida qaytarmaydi. Shuning uchun bepul ekanligi rasmiy hujjatlar asosida
> `server.js` ichidagi `FREE_MODEL_PATTERNS` bilan belgilanadi. Qaysi modellar
> sizning kalitingizda haqiqatdan ishlashini `/api/models` ko'rsatadi.

## 5. Tekshirish
```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/models
```
Kalit to'g'ri bo'lsa, ikkinchisi `models` massivi bilan javob beradi.
Modellar ro'yxati Sozlamalar → API Keys → **Fetch models** yoki ishga tushirishda
avtomatik ravishda yuklanadi va nomlari bilan model tanlagichda chiqadi.

## 6. Kirish / ro'yxatdan o'tish (haqiqiy hisoblar)

`auth.js` serverda ishlaydi. To'rtta usul:

| Usul | Holati |
|---|---|
| Email + parol | Ishlaydi (scrypt xesh + imzolangan sessiya cookie, 30 kun) |
| Google | **Faqat `GOOGLE_CLIENT_ID` bilan ishlaydi** (Client Secret shart emas) |
| GitHub | `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` kerak |
| Telegram | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_BOT_USERNAME` kerak |

Hisoblar `data/users.json` da saqlanadi (parol hech qachon ochiq holda yozilmaydi).
Sessiya imzosi `.auth-secret` da avtomatik yaratiladi. Ikkalasi ham `.gitignore` da.

**Google sozlash:** [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
da *OAuth client ID* (Web application) yarating va **Authorized redirect URIs** ga qo'shing:

```
http://localhost:3000/google-callback.html
```

`.env` ga faqat `GOOGLE_CLIENT_ID` yoziladi (Client Secret kerak emas — ID token
imzosi Google’ning ochiq kalitlari bilan serverda tekshiriladi). Serverni qayta ishga tushiring.
Agar keyinchalik `GOOGLE_CLIENT_SECRET` ham qo'shsangiz, standart code oqimiga o'tadi.

**GitHub:** [OAuth Apps](https://github.com/settings/developers) → *New OAuth App*,
Authorization callback URL: `http://localhost:3000/api/auth/github/callback`.

**Telegram:** @BotFather dan `/newbot` bilan bot oching, token va username ni `.env` ga yozing.

> Admin panel faqat `alimardonovio11@gmail.com` bilan kirganda ko'rinadi.
> Google orqali kirish uchun shu email manzilni ishlatishingiz kerak.

Kalitlar qo'shilmagan usullar kirish ekranida o'chirilgan (disabled) ko'rinadi.
