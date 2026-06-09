import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Internal endpoint called by Spring Boot's CaptchaPreWarmService at 07:01 UTC daily.
 *
 * Flow:
 *  1. Check captchaRequired() — nếu không cần → trả về ngay (fast path)
 *  2. Warm up session bằng get_credits() + delay 2s
 *     (để React app load xong, Create button enabled trước khi browser mở)
 *  3. Gọi generate() với prompt rỗng, wait_audio=false
 *     → generate() tự gọi getCaptcha() bên trong → giải hCaptcha → submit thật đến Suno
 *     → Suno ghi nhận → captchaRequired = false cả ngày
 *  Chi phí: 10 credit/account (reset về 50 lúc 7:00 UTC → còn 40 cho user)
 *
 * POST /api/internal/pre-warm
 * Headers: X-Suno-Cookie: <cookie>
 */
export async function POST(req: NextRequest) {
  const customCookie = req.headers.get('x-suno-cookie');
  if (!customCookie) {
    return new NextResponse(JSON.stringify({ error: 'X-Suno-Cookie header required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  try {
    const api = await sunoApi(customCookie);

    // Fast path: không cần CAPTCHA → không cần generate dummy
    const captchaNeeded = await api.captchaRequired();
    if (!captchaNeeded) {
      console.log('[PreWarm] ✅ Không cần CAPTCHA — account đã sạch, bỏ qua.');
      return new NextResponse(JSON.stringify({
        success: true,
        captchaRequired: false,
        message: 'Không cần CAPTCHA — account đã sạch!'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Warm up session: gọi get_credits() để đảm bảo cookie hoạt động
    // và React app sẽ load xong trước khi browser mở → Create button enabled
    console.log('[PreWarm] CAPTCHA bắt buộc, warm up session...');
    try {
      await api.get_credits();
      console.log('[PreWarm] ✅ Warm-up xong.');
    } catch (e) {
      console.warn('[PreWarm] ⚠️ get_credits() failed, tiếp tục...', e);
    }

    // Delay 2s để session ổn định
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Generate dummy — generate() tự gọi getCaptcha() bên trong
    // → giải hCaptcha → submit thật → Suno xóa captchaRequired cả ngày
    // wait_audio=false: không chờ bài hát xong
    console.log('[PreWarm] Đang generate dummy để Suno xác nhận CAPTCHA...');
    await api.generate('', false, undefined, false);

    console.log('[PreWarm] ✅ Xong! Suno đã xóa CAPTCHA cả ngày cho account này.');
    return new NextResponse(JSON.stringify({
      success: true,
      captchaRequired: true,
      message: 'CAPTCHA đã giải + generate dummy thành công! Cả ngày không cần CAPTCHA nữa.'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (error: any) {
    console.error('[PreWarm] ❌ Thất bại:', error?.message);
    return new NextResponse(JSON.stringify({
      success: false,
      error: error?.message || 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
