// /api/submit-booking.js
// Vercel Serverless Function (Node.js)
// 流程：蜜罐檢查 → Cloudflare Turnstile 後端二次驗證 → 欄位格式校驗 → 寫入 Google Sheet
//
// 需要在 Vercel 專案設定「Environment Variables」中新增：
//   CLOUDFLARE_SECRET_KEY = <你的 Turnstile Secret Key>
//   （Secret Key 與前端 Site Key 不同，只能放在後端，絕對不可寫進前端程式碼）
//   GAS_SHARED_SECRET = <與 Google Apps Script「指令碼屬性」中相同的共享密鑰>
//   （用來防止有人略過本站、直接對 GAS_URL 發送請求）

const GAS_URL = 'https://script.google.com/macros/s/AKfycbzrxJq0NTeoiNvQpyxZ6KDCOovCW8FM_b3BYMvaOM0mGHp7a_GmNkhQ8R6X3X-KuwEMkQ/exec';

// 台灣手機格式：09 開頭 + 8 碼數字，共 10 碼
const PHONE_REGEX = /^09\d{8}$/;
// 姓名欄位上限（沿用前端顯示邏輯，中文姓名/姓名皆用此鍵名）
const NAME_MAX_LENGTH = 8;
// 匯款帳號後五碼：必須剛好 5 個數字
const TRANSFER_CODE_REGEX = /^\d{5}$/;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: '不支援的請求方法' });
  }

  let body = req.body;
  // 保險起見，若平台未自動解析 JSON body，手動解析一次
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ success: false, message: '請求格式錯誤' });
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ success: false, message: '請求格式錯誤' });
  }

  const { b_website, turnstileToken, ...data } = body;

  // ── 1. 蜜罐檢查 ──────────────────────────────────────────────
  // 一般使用者看不到這個欄位，若有值代表是機器人自動填表。
  // 直接假裝成功回傳，但不做任何後續處理（不驗證 Turnstile、不寫入資料）。
  if (b_website) {
    return res.status(200).json({ success: true });
  }

  // ── 2. Cloudflare Turnstile 後端二次驗證 ────────────────────
  if (!turnstileToken) {
    return res.status(400).json({ success: false, message: '缺少人機驗證資訊，請重新整理頁面後再試一次' });
  }

  const secretKey = process.env.CLOUDFLARE_SECRET_KEY;
  if (!secretKey) {
    console.error('CLOUDFLARE_SECRET_KEY 未設定');
    return res.status(500).json({ success: false, message: '伺服器設定錯誤，請稍後再試' });
  }

  try {
    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: secretKey,
        response: turnstileToken,
        remoteip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || undefined,
      }),
    });
    const verifyResult = await verifyRes.json();

    if (!verifyResult.success) {
      console.warn('Turnstile 驗證失敗:', verifyResult['error-codes']);
      return res.status(403).json({ success: false, message: '人機驗證失敗，請重新整理頁面後再試一次' });
    }
  } catch (err) {
    console.error('Turnstile 驗證請求失敗:', err);
    return res.status(502).json({ success: false, message: '人機驗證服務暫時無法使用，請稍後再試' });
  }

  // ── 3. 後端欄位嚴格格式校驗 ──────────────────────────────────
  const phone = String(data['手機'] || '').trim();
  const name = String(data['中文姓名'] || '').trim();

  if (!PHONE_REGEX.test(phone)) {
    return res.status(400).json({ success: false, message: '手機格式錯誤，請輸入台灣手機號碼（例如 0912345678）' });
  }
  if (!name || name.length > NAME_MAX_LENGTH) {
    return res.status(400).json({ success: false, message: `姓名不可為空，且不可超過 ${NAME_MAX_LENGTH} 個字元` });
  }

  // 匯款後五碼：只有這個欄位「有實際填寫」（不是預設的 '—'）時才檢查格式，
  // 因為不是每個表單都需要這個欄位（例如個案預約類的表單就沒有這欄）。
  const transferCode = String(data['匯款後五碼'] || '').trim();
  if (transferCode && transferCode !== '—' && !TRANSFER_CODE_REGEX.test(transferCode)) {
    return res.status(400).json({ success: false, message: '匯款帳號後五碼格式錯誤，請輸入 5 個數字' });
  }

  // ── 4. 處理成功報名 ──────────────────────────────────────────
  try {
    // 將驗證通過的資料轉寫進 Google Sheet（沿用既有的 Google Apps Script）
    // 夾帶共享密鑰，Apps Script 端會核對這把密鑰，避免有人繞過本站直接打 GAS_URL
    const gasSharedSecret = process.env.GAS_SHARED_SECRET;
    if (!gasSharedSecret) {
      console.error('GAS_SHARED_SECRET 未設定');
      return res.status(500).json({ success: false, message: '伺服器設定錯誤，請稍後再試' });
    }

    const sheetRes = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, _secret: gasSharedSecret }),
    });

    let gasResult = {};
    try {
      gasResult = await sheetRes.json();
    } catch (e) {
      // GAS 有時會回傳非 JSON 內容（例如帳號權限錯誤的 HTML 頁面）
    }

    // GAS 不管成功或業務邏輯失敗（例如重複報名、Email 格式錯誤）都回傳 HTTP 200，
    // 真正的結果要看回傳 JSON 裡的 status 欄位，不能只看 HTTP 狀態碼。
    if (!sheetRes.ok || gasResult.status !== 'ok') {
      console.error('Google Sheet 寫入失敗:', sheetRes.status, gasResult);
      // unauthorized：密鑰不match，通常代表 Vercel 與 Apps Script 的 GAS_SHARED_SECRET 沒設定一致
      if (gasResult.message === 'unauthorized') {
        return res.status(502).json({ success: false, message: '伺服器設定錯誤，請稍後再試' });
      }
      return res.status(400).json({ success: false, message: gasResult.message || '資料寫入失敗，請稍後再試或直接與我們聯繫' });
    }

    return res.status(200).json({ success: true, message: '報名成功！' });
  } catch (err) {
    console.error('處理報名時發生錯誤:', err);
    return res.status(500).json({ success: false, message: '伺服器發生錯誤，請稍後再試' });
  }
};
