// /api/index.js (Final and Secure Version with Admin Panel)

/**
 * SHIB Ads WebApp Backend API
 * Handles all POST requests from the Telegram Mini App frontend.
 * Uses the Supabase REST API for persistence.
 */
const crypto = require('crypto');

// Load environment variables for Supabase connection
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
// ⚠️ BOT_TOKEN must be set in Vercel environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
// 🟢 NEW: ADMIN_USER_ID must be set to your Telegram User ID
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? parseInt(process.env.ADMIN_USER_ID) : null; 

// ------------------------------------------------------------------
// Fully secured and defined server-side constants
// ------------------------------------------------------------------
const REWARD_PER_AD = 3;
const REFERRAL_COMMISSION_RATE = 0.05;
const DAILY_MAX_ADS = 100; // Max ads limit
const DAILY_MAX_SPINS = 15; // Max spins limit
const RESET_INTERVAL_MS = 6 * 60 * 60 * 1000; // ⬅️ 6 hours in milliseconds
const MIN_TIME_BETWEEN_ACTIONS_MS = 3000; // 3 seconds minimum time between watchAd/spin requests
const ACTION_ID_EXPIRY_MS = 60000; // 60 seconds for Action ID to be valid
const SPIN_SECTORS = [5, 10, 15, 20, 5];

// ------------------------------------------------------------------
// NEW Task Constants
// ------------------------------------------------------------------
const TASK_REWARD = 50;
const TELEGRAM_CHANNEL_USERNAME = '@botbababab'; // يجب أن يكون هذا هو اسم المستخدم للقناة لبدء التحقق


/**
 * Helper function to randomly select a prize from the defined sectors and return its index.
 */
function calculateRandomSpinPrize() {
    const randomIndex = Math.floor(Math.random() * SPIN_SECTORS.length);
    const prize = SPIN_SECTORS[randomIndex];
    return { prize, prizeIndex: randomIndex };
}

// ------------------------------------------------------------------
// 🟢 NEW: Admin Helper Function
// ------------------------------------------------------------------
function isAdmin(userId) {
    if (!ADMIN_USER_ID) {
        console.error('ADMIN_USER_ID is not configured.');
        return false;
    }
    return userId === ADMIN_USER_ID;
}

// --- Helper Functions ---

function sendSuccess(res, data = {}) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, data }));
}

function sendError(res, message, statusCode = 400) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: message }));
}

async function supabaseFetch(tableName, method, body = null, queryParams = '?select=*') {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase environment variables are not configured.');
  }

  const url = `${SUPABASE_URL}/rest/v1/${tableName}${queryParams}`;

  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  const options = {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  };

  const response = await fetch(url, options);

  if (response.ok) {
      const responseText = await response.text();
      try {
          const jsonResponse = JSON.parse(responseText);
          return Array.isArray(jsonResponse) ? jsonResponse : { success: true };
      } catch (e) {
          return { success: true };
      }
  }

  let data;
  try {
      data = await response.json();
  } catch (e) {
      const errorMsg = `Supabase error: ${response.status} ${response.statusText}`;
      throw new Error(errorMsg);
  }

  const errorMsg = data.message || `Supabase error: ${response.status} ${response.statusText}`;
  throw new Error(errorMsg);
}

/**
 * Checks if a user is a member (or creator/admin) of a specific Telegram channel.
 */
async function checkChannelMembership(userId, channelUsername) {
    if (!BOT_TOKEN) {
        console.error('BOT_TOKEN is not configured for membership check.');
        return false;
    }
    
    // The chat_id must be in the format @username or -100xxxxxxxxxx
    const chatId = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`; 

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${chatId}&user_id=${userId}`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errorData = await response.json();
            console.error('Telegram API error (getChatMember):', errorData.description || response.statusText);
            return false;
        }

        const data = await response.json();
        
        if (!data.ok) {
             console.error('Telegram API error (getChatMember - not ok):', data.description);
             return false;
        }

        const status = data.result.status;
        
        // Accepted statuses are 'member', 'administrator', 'creator'
        const isMember = ['member', 'administrator', 'creator'].includes(status);
        
        return isMember;

    } catch (error) {
        console.error('Network or parsing error during Telegram API call:', error.message);
        return false;
    }
}


/**
 * Limit-Based Reset Logic: Resets counters if the limit was reached AND the interval (6 hours) has passed since.
 * ⚠️ هذا هو التعديل الرئيسي: يعتمد على أعمدة الوصول للحد الأقصى وليس على آخر نشاط عام.
 */
async function resetDailyLimitsIfExpired(userId) {
    const now = Date.now();

    try {
        // 1. Fetch current limits and the time they were reached
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${userId}&select=ads_watched_today,spins_today,ads_limit_reached_at,spins_limit_reached_at`);
        if (!Array.isArray(users) || users.length === 0) {
            return;
        }

        const user = users[0];
        const updatePayload = {};

        // 2. Check Ads Limit Reset
        if (user.ads_limit_reached_at && user.ads_watched_today >= DAILY_MAX_ADS) {
            const adsLimitTime = new Date(user.ads_limit_reached_at).getTime();
            if (now - adsLimitTime > RESET_INTERVAL_MS) {
                // ⚠️ تم مرور 6 ساعات على الوصول للحد الأقصى، يتم إعادة التعيين
                updatePayload.ads_watched_today = 0;
                updatePayload.ads_limit_reached_at = null; // إزالة الوقت لانتهاء فترة القفل
                console.log(`Ads limit reset for user ${userId}.`);
            }
        }

        // 3. Check Spins Limit Reset
        if (user.spins_limit_reached_at && user.spins_today >= DAILY_MAX_SPINS) {
            const spinsLimitTime = new Date(user.spins_limit_reached_at).getTime();
            if (now - spinsLimitTime > RESET_INTERVAL_MS) {
                // ⚠️ تم مرور 6 ساعات على الوصول للحد الأقصى، يتم إعادة التعيين
                updatePayload.spins_today = 0;
                updatePayload.spins_limit_reached_at = null; // إزالة الوقت لانتهاء فترة القفل
                console.log(`Spins limit reset for user ${userId}.`);
            }
        }

        // 4. Perform the database update if any limits were reset
        if (Object.keys(updatePayload).length > 0) {
            await supabaseFetch('users', 'PATCH',
                updatePayload,
                `?id=eq.${userId}`);
        }
    } catch (error) {
        console.error(`Failed to check/reset daily limits for user ${userId}:`, error.message);
    }
}

/**
 * Rate Limiting Check for Ad/Spin Actions
 * ⚠️ تم تعديلها: لم تعد تحدث last_activity، بل فقط تفحص الفارق الزمني الأخير
 */
async function checkRateLimit(userId) {
    try {
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${userId}&select=last_activity`);
        if (!Array.isArray(users) || users.length === 0) {
            return { ok: true };
        }

        const user = users[0];
        // إذا كان last_activity غير موجود، يمكن اعتباره 0 لضمان السماح بالمرور
        const lastActivity = user.last_activity ? new Date(user.last_activity).getTime() : 0; 
        const now = Date.now();
        const timeElapsed = now - lastActivity;

        if (timeElapsed < MIN_TIME_BETWEEN_ACTIONS_MS) {
            const remainingTime = MIN_TIME_BETWEEN_ACTIONS_MS - timeElapsed;
            return {
                ok: false,
                message: `Rate limit exceeded. Please wait ${Math.ceil(remainingTime / 1000)} seconds before the next action.`,
                remainingTime: remainingTime
            };
        }
        // تحديث last_activity سيتم لاحقاً في دوال watchAd/spinResult
        return { ok: true };
    } catch (error) {
        console.error(`Rate limit check failed for user ${userId}:`, error.message);
        return { ok: true };
    }
}

// ------------------------------------------------------------------
// **initData Security Validation Function** (No change)
// ------------------------------------------------------------------
function validateInitData(initData) {
    if (!initData || !BOT_TOKEN) {
        console.warn('Security Check Failed: initData or BOT_TOKEN is missing.');
        return false;
    }

    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const dataCheckString = Array.from(urlParams.entries())
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
        .update(BOT_TOKEN)
        .digest();

    const calculatedHash = crypto.createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    if (calculatedHash !== hash) {
        console.warn(`Security Check Failed: Hash mismatch.`);
        return false;
    }

    const authDateParam = urlParams.get('auth_date');
    if (!authDateParam) {
        console.warn('Security Check Failed: auth_date is missing.');
        return false;
    }

    const authDate = parseInt(authDateParam) * 1000;
    const currentTime = Date.now();
    const expirationTime = 1200 * 1000; // 20 minutes limit

    if (currentTime - authDate > expirationTime) {
        console.warn(`Security Check Failed: Data expired.`);
        return false;
    }

    return true;
}

// ------------------------------------------------------------------
// 🔑 Commission Helper Function (No change)
// ------------------------------------------------------------------
/**
 * Processes the commission for the referrer and updates their balance.
 */
async function processCommission(referrerId, refereeId, sourceReward) {
    // 1. Calculate commission
    const commissionAmount = sourceReward * REFERRAL_COMMISSION_RATE; 
    
    if (commissionAmount < 0.000001) { 
        console.log(`Commission too small (${commissionAmount}). Aborted for referee ${refereeId}.`);
        return { ok: false, error: 'Commission amount is effectively zero.' };
    }

    try {
        // 2. Fetch referrer's current balance and status
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${referrerId}&select=balance,is_banned`);
        if (!Array.isArray(users) || users.length === 0 || users[0].is_banned) {
             console.log(`Referrer ${referrerId} not found or banned. Commission aborted.`);
             return { ok: false, error: 'Referrer not found or banned, commission aborted.' };
        }
        
        // 3. Update balance: newBalance will now include the decimal commission
        const newBalance = users[0].balance + commissionAmount;
        
        // 4. Update referrer balance
        await supabaseFetch('users', 'PATCH', { balance: newBalance }, `?id=eq.${referrerId}`); 

        // 5. Add record to commission_history
        await supabaseFetch('commission_history', 'POST', { referrer_id: referrerId, referee_id: refereeId, amount: commissionAmount, source_reward: sourceReward }, '?select=referrer_id');
        
        console.log(`Commission of ${commissionAmount} SHIB processed for referrer ${referrerId} from referee ${refereeId}.`);
        return { ok: true, data: { commission_amount: commissionAmount } };

    } catch (error) {
        console.error(`Commission processing failed for referrer ${referrerId}:`, error.message);
        return { ok: false, error: error.message };
    }
}

// ------------------------------------------------------------------
// 🛡️ Action ID Functions (Anti-Cheat Mechanism) (No change)
// ------------------------------------------------------------------

/**
 * Generates a strong, unique ID.
 */
function generateStrongId() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * HANDLER: type: "generateActionId"
 * Creates a unique, temporary ID for a specific user action (e.g., watchAd, preSpin, withdraw).
 * This prevents replay attacks and ensures the request originated from the web app.
 */
async function handleGenerateActionId(req, res, body) {
    const { user_id, action_type } = body;
    const id = parseInt(user_id);
    const allowedActionTypes = ['watchAd', 'preSpin', 'withdraw', 'completeTask'];

    if (!allowedActionTypes.includes(action_type)) {
        return sendError(res, 'Invalid action type.', 400);
    }
    
    // Cleanup old IDs for the current user/action type to prevent database clutter
    try {
        const queryTime = Date.now() - ACTION_ID_EXPIRY_MS;
        const tempActions = await supabaseFetch('temp_actions', 'GET', null, 
            `?user_id=eq.${id}&action_type=eq.${action_type}&created_at=lt.${new Date(queryTime).toISOString()}&select=id`);

        if (Array.isArray(tempActions) && tempActions.length > 0) {
             await supabaseFetch('temp_actions', 'DELETE', null, `?user_id=eq.${id}&action_type=eq.${action_type}`);
        }
    } catch(e) {
        console.warn('Error checking existing temp_actions:', e.message);
    }
    
    // Generate and save the new ID
    const newActionId = generateStrongId();
    try {
        await supabaseFetch('temp_actions', 'POST', { user_id: id, action_id: newActionId, action_type: action_type }, '?select=action_id');
        sendSuccess(res, { action_id: newActionId });
    } catch (error) {
        console.error('Failed to generate and save action ID:', error.message);
        sendError(res, 'Failed to generate security token.', 500);
    }
}

/**
 * Middleware: Checks if the Action ID is valid and then deletes it.
 */
async function validateAndUseActionId(res, userId, actionId, actionType) {
    if (!actionId) {
        sendError(res, 'Missing Server Token (Action ID). Request rejected.', 400);
        return false;
    }
    
    try {
        const query = `?user_id=eq.${userId}&action_id=eq.${actionId}&action_type=eq.${actionType}&select=id,created_at`;
        const tempActions = await supabaseFetch('temp_actions', 'GET', null, query);

        if (!Array.isArray(tempActions) || tempActions.length === 0) {
            sendError(res, 'Invalid or expired Server Token. Request rejected.', 401);
            return false;
        }

        const action = tempActions[0];
        const createdAt = new Date(action.created_at).getTime();
        const now = Date.now();

        if (now - createdAt > ACTION_ID_EXPIRY_MS) {
            sendError(res, 'Server Token expired. Please try the action again.', 401);
            return false;
        }

        // Delete the used token immediately
        await supabaseFetch('temp_actions', 'DELETE', null, `?action_id=eq.${actionId}`);

        return true;

    } catch (error) {
        console.error(`Action ID validation failed for ${actionId}:`, error.message);
        sendError(res, 'Internal server error during token validation.', 500);
        return false;
    }
}


// ------------------------------------------------------------------
// **API HANDLERS**
// ------------------------------------------------------------------

/**
 * 1) type: "getUserData"
 * Retrieves a user's current status and data.
 */
async function handleGetUserData(req, res, body) {
    const { user_id } = body;
    const id = parseInt(user_id);

    // 1. Perform limit checks and resets before fetching data
    await resetDailyLimitsIfExpired(id);

    try {
        // 2. Fetch basic user data
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id,balance,ads_watched_today,spins_today,is_banned,last_activity,task_completed`);
        if (!ArrayOfUsers(users)) {
            return sendError(res, 'User not found. Please register first.', 404);
        }
        const userData = users[0];

        // 3. Banned Check
        if (userData.is_banned) {
            return sendSuccess(res, { is_banned: true });
        }
        
        // 4. Fetch referrals count
        const referrals = await supabaseFetch('users', 'GET', null, `?ref_by=eq.${id}&select=id`);
        const referralsCount = Array.isArray(referrals) ? referrals.length : 0;

        // 5. Fetch withdrawal history
        const history = await supabaseFetch('withdrawals', 'GET', null, `?user_id=eq.${id}&select=amount,status,created_at&order=created_at.desc`);
        const withdrawalHistory = Array.isArray(history) ? history : [];
        
        // 6. Update last_activity (only for Rate Limit purposes now)
        await supabaseFetch('users', 'PATCH', { last_activity: new Date().toISOString() }, `?id=eq.${id}&select=id`);

        sendSuccess(res, {
            ...userData,
            referrals_count: referralsCount,
            withdrawal_history: withdrawalHistory
        });

    } catch (error) {
        console.error('GetUserData failed:', error.message);
        sendError(res, `Failed to retrieve user data: ${error.message}`, 500);
    }
}

/**
 * 1) type: "register"
 * ⚠️ Fix: Includes task_completed: false for new users.
 */
async function handleRegister(req, res, body) {
    const { user_id, ref_by } = body;
    const id = parseInt(user_id);
    const referrerId = ref_by ? parseInt(ref_by) : null;

    try {
        // 1. Check if user already exists
        const existingUsers = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id`);
        if (ArrayOfUsers(existingUsers)) {
            // User exists, proceed to limit check/reset and return success
            await resetDailyLimitsIfExpired(id);
            return sendSuccess(res, { message: 'User already registered.' });
        }

        // 2. Register new user
        const newUser = {
            id: id,
            balance: 0,
            ads_watched_today: 0,
            spins_today: 0,
            is_banned: false,
            ref_by: referrerId,
            task_completed: false, // NEW: Default to false
            last_activity: new Date().toISOString()
        };
        await supabaseFetch('users', 'POST', newUser);

        sendSuccess(res, { message: 'User registered successfully.' });
    } catch (error) {
        console.error('Register failed:', error.message);
        sendError(res, `Registration failed: ${error.message}`, 500);
    }
}

/**
 * 2) type: "watchAd"
 * Processes reward after the user has watched two ads.
 */
async function handleWatchAd(req, res, body) {
    const { user_id, action_id } = body;
    const id = parseInt(user_id);
    const reward = REWARD_PER_AD;

    // 1. Validate the action ID and consume the token
    if (!await validateAndUseActionId(res, id, action_id, 'watchAd')) return;

    // 2. Check and reset daily limits (if 6 hours passed since limit reached)
    await resetDailyLimitsIfExpired(id);

    try {
        // 3. Fetch current user data
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,ads_watched_today,is_banned,ref_by`);
        if (!ArrayOfUsers(users)) {
            return sendError(res, 'User not found.', 404);
        }
        const user = users[0];
        const referrerId = user.ref_by; // Used for commission only

        // 4. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        // 5. Rate Limit Check
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
            return sendError(res, rateLimitResult.message, 429);
        }

        // 6. Check maximum ad limit
        if (user.ads_watched_today >= DAILY_MAX_ADS) {
            return sendError(res, `Daily ad limit (${DAILY_MAX_ADS}) reached.`, 403);
        }

        // 7. Calculate new values
        const newBalance = user.balance + reward;
        const newAdsCount = user.ads_watched_today + 1;
        const updatePayload = {
            balance: newBalance,
            ads_watched_today: newAdsCount,
            last_activity: new Date().toISOString() // ⬅️ تحديث لـ Rate Limit
        };

        // 8. ⚠️ NEW LOGIC: Check if the limit is reached NOW
        if (newAdsCount >= DAILY_MAX_ADS) {
            updatePayload.ads_limit_reached_at = new Date().toISOString();
        }

        // 9. Update user record
        await supabaseFetch('users', 'PATCH', updatePayload, `?id=eq.${id}`);

        // 10. Commission Call
        // The frontend will handle sending the commission request separately using the actual reward
        
        sendSuccess(res, {
            new_balance: newBalance,
            new_ads_count: newAdsCount,
            actual_reward: reward,
            message: 'Ad reward processed successfully.'
        });

    } catch (error) {
        console.error('WatchAd failed:', error.message);
        sendError(res, `Failed to process ad reward: ${error.message}`, 500);
    }
}

/**
 * 3) type: "commission"
 * Handles referral commission payout.
 */
async function handleCommission(req, res, body) {
    const { referrer_id, source_reward } = body;
    const refereeId = body.user_id; // User who generated the reward is the referee
    
    // NOTE: initData validation is skipped for commission as it's an internal, secondary request.
    
    if (!referrer_id || !source_reward || !refereeId) {
         return sendError(res, 'Missing referrer_id, source_reward, or user_id for commission.', 400);
    }

    // 1. The core logic is in the helper function
    const result = await processCommission(parseInt(referrer_id), parseInt(refereeId), source_reward);

    if (result.ok) {
        sendSuccess(res, result.data);
    } else {
        sendError(res, result.error);
    }
}

/**
 * 4) type: "preSpin"
 * Checks limits and generates the spin result *before* the spin animation starts.
 * This result is returned to the frontend to control the spin animation.
 */
async function handlePreSpin(req, res, body) {
    const { user_id, action_id } = body;
    const id = parseInt(user_id);
    
    // 1. Validate the action ID and consume the token
    if (!await validateAndUseActionId(res, id, action_id, 'preSpin')) return;

    // 2. Check and reset daily limits
    await resetDailyLimitsIfExpired(id);

    try {
        // 3. Fetch current user data (only spins needed for immediate check)
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=spins_today,is_banned`);
        if (!ArrayOfUsers(users)) {
            return sendError(res, 'User not found.', 404);
        }
        const user = users[0];

        // 4. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        // 5. Rate Limit Check
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
            return sendError(res, rateLimitResult.message, 429);
        }

        // 6. Check maximum spin limit
        if (user.spins_today >= DAILY_MAX_SPINS) {
            return sendError(res, `Daily spin limit (${DAILY_MAX_SPINS}) reached.`, 403);
        }

        // 7. Calculate and store the prize for later use in spinResult
        const { prize, prizeIndex } = calculateRandomSpinPrize();
        
        // 8. Overwrite the consumed preSpin token with the final prize result
        const updatePayload = {
             user_id: id,
             action_id: action_id, // Reuse the same action_id
             action_type: 'spinResult', // Change type to 'spinResult'
             prize_value: prize,
             prize_index: prizeIndex,
             created_at: new Date().toISOString() // Reset timer for validation
        };

        // This ensures the action_id now represents the 'spinResult' and contains the prize data.
        await supabaseFetch('temp_actions', 'POST', updatePayload, '?select=id');
        
        // 9. Send success with the prize index to the frontend for animation
        sendSuccess(res, {
            prize_index: prizeIndex,
            message: 'Spin outcome determined.'
        });

    } catch (error) {
        console.error('PreSpin failed:', error.message);
        sendError(res, `Failed to initialize spin: ${error.message}`, 500);
    }
}

/**
 * 5) type: "spinResult"
 * Processes reward after the spin animation is complete.
 */
async function handleSpinResult(req, res, body) {
    const { user_id, action_id } = body;
    const id = parseInt(user_id);

    // 1. Validate the action ID and consume the 'spinResult' token which contains the prize
    const validationResult = await validateAndUseActionIdWithPrize(res, id, action_id, 'spinResult');
    if (!validationResult.ok) return;

    const { actual_prize, prize_index } = validationResult.data;
    const reward = actual_prize; // This is the final prize to be awarded

    // 2. Check and reset daily limits (if 6 hours passed since limit reached)
    await resetDailyLimitsIfExpired(id);

    try {
        // 3. Fetch current user data
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,spins_today,is_banned,ref_by`);
        if (!ArrayOfUsers(users)) {
            return sendError(res, 'User not found.', 404);
        }
        const user = users[0];
        const referrerId = user.ref_by; // Used for commission only

        // 4. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        // 5. Rate Limit Check
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
            return sendError(res, rateLimitResult.message, 429);
        }

        // 6. Check maximum spin limit (final check)
        if (user.spins_today >= DAILY_MAX_SPINS) {
            return sendError(res, `Daily spin limit (${DAILY_MAX_SPINS}) reached.`, 403);
        }

        // 7. Calculate new values
        const newBalance = user.balance + reward;
        const newSpinsCount = user.spins_today + 1;
        const updatePayload = {
            balance: newBalance,
            spins_today: newSpinsCount,
            last_activity: new Date().toISOString() // ⬅️ تحديث لـ Rate Limit
        };

        // 8. ⚠️ NEW LOGIC: Check if the limit is reached NOW
        if (newSpinsCount >= DAILY_MAX_SPINS) {
            updatePayload.spins_limit_reached_at = new Date().toISOString();
        }

        // 9. Update user record
        await supabaseFetch('users', 'PATCH', updatePayload, `?id=eq.${id}`);

        // 10. Commission Call
        // The frontend will handle sending the commission request separately using the actual reward

        sendSuccess(res, {
            new_balance: newBalance,
            new_spins_count: newSpinsCount,
            actual_prize: reward,
            prize_index: prize_index,
            message: 'Spin reward processed successfully.'
        });

    } catch (error) {
        console.error('SpinResult failed:', error.message);
        sendError(res, `Failed to process spin reward: ${error.message}`, 500);
    }
}

/**
 * Helper for spinResult: Validates the Action ID and extracts the stored prize.
 */
async function validateAndUseActionIdWithPrize(res, userId, actionId, actionType) {
    if (!actionId) {
        sendError(res, 'Missing Server Token (Action ID). Request rejected.', 400);
        return { ok: false };
    }
    
    try {
        const query = `?user_id=eq.${userId}&action_id=eq.${actionId}&action_type=eq.${actionType}&select=id,created_at,prize_value,prize_index`;
        const tempActions = await supabaseFetch('temp_actions', 'GET', null, query);

        if (!ArrayOfUsers(tempActions)) {
            sendError(res, 'Invalid or expired Server Token. Request rejected.', 401);
            return { ok: false };
        }

        const action = tempActions[0];
        const createdAt = new Date(action.created_at).getTime();
        const now = Date.now();

        if (now - createdAt > ACTION_ID_EXPIRY_MS) {
            sendError(res, 'Server Token expired. Please try the action again.', 401);
            return { ok: false };
        }
        
        // Ensure prize data is present
        if (action.prize_value === undefined || action.prize_index === undefined) {
             sendError(res, 'Server Token missing prize data. Fraud detected.', 401);
             return { ok: false };
        }

        // Delete the used token immediately
        await supabaseFetch('temp_actions', 'DELETE', null, `?action_id=eq.${actionId}`);

        return { 
            ok: true, 
            data: {
                actual_prize: action.prize_value,
                prize_index: action.prize_index
            }
        };

    } catch (error) {
        console.error(`Action ID validation failed for ${actionId}:`, error.message);
        sendError(res, 'Internal server error during token validation.', 500);
        return { ok: false };
    }
}


/**
 * 6) type: "withdraw"
 * Processes a withdrawal request.
 */
async function handleWithdraw(req, res, body) {
    const { user_id, binanceId, amount, action_id } = body;
    const id = parseInt(user_id);
    const withdrawalAmount = parseInt(amount);

    // 1. Validate the action ID and consume the token
    if (!await validateAndUseActionId(res, id, action_id, 'withdraw')) return;

    if (!binanceId || isNaN(withdrawalAmount) || withdrawalAmount < 10000) {
        return sendError(res, 'Invalid or insufficient withdrawal amount (Min 10,000 SHIB) or missing ID.', 400);
    }

    try {
        // 2. Fetch current user data
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,is_banned`);
        if (!ArrayOfUsers(users)) {
            return sendError(res, 'User not found.', 404);
        }
        const user = users[0];

        // 3. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        // 4. Check balance
        if (user.balance < withdrawalAmount) {
            return sendError(res, 'Insufficient balance for this withdrawal amount.', 403);
        }
        
        // 5. Rate Limit Check
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
            return sendError(res, rateLimitResult.message, 429);
        }

        // 6. Deduct balance immediately
        const newBalance = user.balance - withdrawalAmount;
        const updatePayload = {
            balance: newBalance,
            last_activity: new Date().toISOString() // ⬅️ تحديث لـ Rate Limit
        };

        await supabaseFetch('users', 'PATCH', updatePayload, `?id=eq.${id}`);

        // 7. Create withdrawal record (status: pending)
        const withdrawalRecord = {
            user_id: id,
            amount: withdrawalAmount,
            binance_id: binanceId,
            status: 'pending'
        };
        await supabaseFetch('withdrawals', 'POST', withdrawalRecord);

        sendSuccess(res, {
            new_balance: newBalance,
            message: 'Withdrawal request submitted successfully.'
        });

    } catch (error) {
        console.error('Withdrawal failed:', error.message);
        sendError(res, `Withdrawal failed: ${error.message}`, 500);
    }
}

/**
 * 7) type: "completeTask"
 * Processes the one-time task reward after channel membership verification.
 */
async function handleCompleteTask(req, res, body) {
    const { user_id, action_id } = body;
    const id = parseInt(user_id);
    const reward = TASK_REWARD;
    
    // 1. Validate the action ID and consume the token
    if (!await validateAndUseActionId(res, id, action_id, 'completeTask')) return;

    try {
        // 2. Fetch current user data
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,is_banned,task_completed,ref_by`);
        if (!ArrayOfUsers(users)) {
            return sendError(res, 'User not found.', 404);
        }
        const user = users[0];
        const referrerId = user.ref_by;
        
        // 3. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        // 4. Check if task is already completed
        if (user.task_completed) {
            return sendError(res, 'Task already completed.', 403);
        }
        
        // 5. Check Rate Limit (Good practice for anti-spam)
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
            return sendError(res, rateLimitResult.message, 429);
        }

        // 6. 🚨 CRITICAL: Check Channel Membership using Telegram API
        const isMember = await checkChannelMembership(id, TELEGRAM_CHANNEL_USERNAME);
        if (!isMember) {
            return sendError(res, 'User has not joined the required channel.', 400);
        }

        // 7. Process Reward and Update User Data
        const newBalance = user.balance + reward;
        const updatePayload = {
            balance: newBalance,
            task_completed: true, // Mark as completed
            last_activity: new Date().toISOString() // Update for Rate Limit
        };
        await supabaseFetch('users', 'PATCH', updatePayload, `?id=eq.${id}`);

        // 8. Success
        sendSuccess(res, {
            new_balance: newBalance,
            actual_reward: reward,
            message: 'Task completed successfully.'
        });

    } catch (error) {
        console.error('CompleteTask failed:', error.message);
        sendError(res, `Failed to complete task: ${error.message}`, 500);
    }
}


/**
 * 8) type: "getAdminData"
 * Retrieves data needed for the admin panel.
 */
async function handleGetAdminData(req, res, body) {
    const { user_id } = body;
    const id = parseInt(user_id);

    if (!isAdmin(id)) {
        return sendError(res, 'Access Denied: Not an admin.', 403);
    }

    try {
        // Fetch pending withdrawals
        const pendingWithdrawals = await supabaseFetch('withdrawals', 'GET', null, `?status=eq.pending&select=id,user_id,amount,binance_id,created_at`);
        
        // Fetch all users to map IDs to data (optional, but useful to show ban status)
        const allUsers = await supabaseFetch('users', 'GET', null, `?select=id,is_banned`);
        const userMap = (Array.isArray(allUsers) ? allUsers : []).reduce((acc, user) => {
            acc[user.id] = { is_banned: user.is_banned };
            return acc;
        }, {});

        // Combine
        const data = (Array.isArray(pendingWithdrawals) ? pendingWithdrawals : []).map(w => ({
            ...w,
            is_banned: userMap[w.user_id]?.is_banned || false // Check if the user is banned
        }));

        sendSuccess(res, { pendingWithdrawals: data });

    } catch (error) {
        console.error('GetAdminData failed:', error.message);
        sendError(res, `Failed to retrieve admin data: ${error.message}`, 500);
    }
}

/**
 * 9) type: "updateWithdrawalStatus"
 * Updates a pending withdrawal status (completed or rejected).
 */
async function handleUpdateWithdrawalStatus(req, res, body) {
    const { user_id, withdrawal_id, new_status } = body;
    const id = parseInt(user_id);
    const wId = parseInt(withdrawal_id);

    if (!isAdmin(id)) {
        return sendError(res, 'Access Denied: Not an admin.', 403);
    }

    if (!wId || !['completed', 'rejected'].includes(new_status)) {
        return sendError(res, 'Invalid withdrawal ID or status.', 400);
    }

    try {
        // 1. Fetch the withdrawal request
        const withdrawals = await supabaseFetch('withdrawals', 'GET', null, `?id=eq.${wId}&select=status,user_id,amount`);
        if (!ArrayOfUsers(withdrawals)) {
            return sendError(res, 'Withdrawal request not found.', 404);
        }
        const withdrawal = withdrawals[0];

        if (withdrawal.status !== 'pending') {
            return sendError(res, `Withdrawal is already ${withdrawal.status}.`, 400);
        }

        // 2. Update status
        await supabaseFetch('withdrawals', 'PATCH', { status: new_status }, `?id=eq.${wId}`);
        
        let message = `Withdrawal ${wId} status updated to ${new_status}.`;
        const targetUserId = withdrawal.user_id;

        // 3. Refund logic if rejected
        if (new_status === 'rejected') {
            const refundAmount = withdrawal.amount;
            const users = await supabaseFetch('users', 'GET', null, `?id=eq.${targetUserId}&select=balance`);

            if (ArrayOfUsers(users)) {
                const currentBalance = users[0].balance;
                const newBalance = currentBalance + refundAmount;
                await supabaseFetch('users', 'PATCH', { balance: newBalance }, `?id=eq.${targetUserId}`);
                message += ` Funds (${refundAmount} SHIB) returned to user ${targetUserId}'s balance.`;
            } else {
                message += ` WARNING: Could not find user ${targetUserId} to return funds.`;
            }
        }

        // 4. Success
        sendSuccess(res, { message, withdrawal_id: wId, new_status: new_status });

    } catch (error) {
        console.error('UpdateWithdrawalStatus failed:', error.message);
        sendError(res, `Failed to update withdrawal status: ${error.message}`, 500);
    }
}

/**
 * HANDLER: type: "banUser"
 * Bans or unbans a target user.
 */
async function handleBanUser(req, res, body) {
    const { user_id, target_user_id, action } = body;
    const id = parseInt(user_id);
    const targetId = parseInt(target_user_id);

    if (!isAdmin(id)) {
        return sendError(res, 'Access Denied: Not an admin.', 403);
    }
    if (!targetId || !['ban', 'unban'].includes(action)) {
        return sendError(res, 'Invalid target user ID or action.', 400);
    }
    if (id === targetId) {
        return sendError(res, 'You cannot ban/unban yourself.', 400);
    }
    
    const is_banned_value = action === 'ban';

    try {
        // Check if user exists
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${targetId}&select=id`);
        if (!ArrayOfUsers(users)) {
            return sendError(res, 'Target user not found.', 404);
        }

        // Update the ban status
        await supabaseFetch('users', 'PATCH', { is_banned: is_banned_value }, `?id=eq.${targetId}`);

        sendSuccess(res, { message: `User ${targetId} has been ${action}ned.`, user_id: targetId, status: action });

    } catch (error) {
        console.error('BanUser failed:', error.message);
        sendError(res, `Failed to ${action} user: ${error.message}`, 500);
    }
}

function ArrayOfUsers(users) {
    return Array.isArray(users) && users.length > 0;
}

// ------------------------------------------------------------------
// **MAIN EXPORT HANDLER**
// ------------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendError(res, 'Method not allowed', 405);
  }

  // Parse the JSON body
  let body;
  try {
    body = JSON.parse(await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => { resolve(data); });
    }));
  } catch (e) {
    return sendError(res, 'Invalid JSON body', 400);
  }
  
  const { initData } = body;

  // 1. All user-initiated requests must pass initData validation (except commission, which is internal)
  // The Admin panel requests rely on isAdmin check, not initData check
  if (body.type !== 'commission' && body.type !== 'getAdminData' && body.type !== 'updateWithdrawalStatus' && body.type !== 'banUser' && !validateInitData(initData)) {
      return sendError(res, 'Invalid or expired initData. Security check failed.', 401);
  }

  if (!body.user_id && body.type !== 'commission') {
      return sendError(res, 'Missing user_id in the request body.', 400);
  }

  // Route the request based on the 'type' field
  switch (body.type) {
    case 'getUserData':
      await handleGetUserData(req, res, body);
      break;
    case 'register':
      await handleRegister(req, res, body);
      break;
    case 'watchAd':
      await handleWatchAd(req, res, body);
      break;
    case 'commission':
      await handleCommission(req, res, body);
      break;
    case 'preSpin': 
      await handlePreSpin(req, res, body);
      break;
    case 'spinResult': 
      await handleSpinResult(req, res, body);
      break;
    case 'withdraw':
      await handleWithdraw(req, res, body);
      break;
    case 'completeTask': // ⬅️ Handle the new task logic
      await handleCompleteTask(req, res, body);
      break;
    case 'generateActionId': 
      await handleGenerateActionId(req, res, body);
      break;
      
    // 🟢 NEW ADMIN ROUTES
    case 'getAdminData':
        await handleGetAdminData(req, res, body);
        break;
    case 'updateWithdrawalStatus':
        await handleUpdateWithdrawalStatus(req, res, body);
        break;
    case 'banUser':
        await handleBanUser(req, res, body);
        break;
        
    default:
      sendError(res, 'Invalid API request type.', 400);
      break;
  }
};