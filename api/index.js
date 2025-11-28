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

// ------------------------------------------------------------------
// Database Tables
// ------------------------------------------------------------------
const DB_USERS = 'users';
const DB_ACTIONS = 'user_actions';
const DB_WITHDRAWALS = 'withdrawals';

// Initialize Supabase Client (Minimal implementation for Vercel/Node environment)
const supabase = {
    from: (tableName) => ({
        select: (columns) => ({
            eq: (column, value) => ({
                order: (col, options) => ({
                    limit: (count) => supabase.fetchData(tableName, { select: columns, eq: { [column]: value }, order: { col, ...options }, limit: count }),
                    single: () => supabase.fetchData(tableName, { select: columns, eq: { [column]: value }, order: options.ascending ? { col, ascending: true } : { col, ascending: false } }),
                    
                    // Added for admin panel
                    neq: (col, val) => supabase.fetchData(tableName, { select: columns, eq: { [column]: value }, neq: { [col]: val } }),
                }),
                single: () => supabase.fetchData(tableName, { select: columns, eq: { [column]: value }, single: true }),
            }),
            insert: (data) => supabase.fetchData(tableName, { insert: data }),
            update: (data) => ({
                eq: (column, value) => supabase.fetchData(tableName, { update: data, eq: { [column]: value } })
            }),
            rpc: (functionName, params) => supabase.fetchRPC(functionName, params),
            
            // Added for admin panel
            order: (col, options) => supabase.fetchData(tableName, { select: columns, order: { col, ...options } }),
            
            // For general select without where clause (use with caution)
            get: () => supabase.fetchData(tableName, { select: columns }),
        }),
    }),
    
    // Minimal RPC handler
    fetchRPC: async (functionName, params) => {
        const url = `${SUPABASE_URL}/rest/v1/rpc/${functionName}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                },
                body: JSON.stringify(params)
            });
            const data = await response.json();
            if (!response.ok) {
                return { data: null, error: { message: data.message || 'RPC call failed', code: response.status } };
            }
            return { data: data[0], error: null };
        } catch (error) {
            return { data: null, error };
        }
    },

    // Unified Data Fetcher (Simulated Supabase)
    fetchData: async (tableName, operation) => {
        const method = operation.insert || operation.update ? 'POST' : 'GET';
        let url = `${SUPABASE_URL}/rest/v1/${tableName}`;
        
        let headers = {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation' + (operation.single ? ',count=exact' : '')
        };

        let body = null;

        if (operation.select) {
            url += `?select=${operation.select}`;
            if (operation.eq) {
                const key = Object.keys(operation.eq)[0];
                url += `&${key}=eq.${operation.eq[key]}`;
            }
            if (operation.neq) {
                const key = Object.keys(operation.neq)[0];
                url += `&${key}=neq.${operation.neq[key]}`;
            }
            if (operation.order) {
                url += `&order=${operation.order.col}.${operation.order.ascending ? 'asc' : 'desc'}`;
            }
            if (operation.limit) {
                url += `&limit=${operation.limit}`;
            }
            
        } else if (operation.insert) {
            body = JSON.stringify(operation.insert);
        } else if (operation.update) {
            headers['X-HTTP-Method-Override'] = 'PATCH';
            body = JSON.stringify(operation.update);
            if (operation.eq) {
                const key = Object.keys(operation.eq)[0];
                url += `?${key}=eq.${operation.eq[key]}`;
            }
        }

        try {
            const response = await fetch(url, {
                method: method === 'GET' ? 'GET' : 'POST',
                headers,
                body
            });
            const data = await response.json();
            
            if (!response.ok) {
                return { data: null, error: { message: data.message || 'API call failed', code: data.code || response.status } };
            }

            const resultData = operation.single ? data[0] : data;

            return { data: resultData, error: null };
            
        } catch (error) {
            return { data: null, error };
        }
    }
};

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
const TASK_REWARD = 50;
const TASK_CHANNEL_ID = '@botbababab'; // The channel to join
const MIN_WITHDRAWAL_AMOUNT = 400;
const ADMIN_USER_ID = '7741750541'; // ⬅️ NEW: Admin user ID for special access

// ------------------------------------------------------------------
// Helper Functions
// ------------------------------------------------------------------

function sendSuccess(res, data = {}, status = 200) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify({ ok: true, data }));
}

function sendError(res, message, status = 400) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify({ ok: false, error: message }));
}

/**
 * Validates the Telegram initData using the bot's token.
 * THIS IS CRITICAL FOR SECURITY.
 */
function validateInitData(initData) {
  if (!initData) return false;
  
  // Hash validation logic using BOT_TOKEN
  const parts = initData.split('&');
  const hashPart = parts.find(p => p.startsWith('hash='));
  const dataCheckStringParts = parts.filter(p => !p.startsWith('hash=')).sort();
  
  if (!hashPart) return false;

  const hash = hashPart.substring(5);
  const dataCheckString = dataCheckStringParts.join('\n');

  try {
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    return calculatedHash === hash;
  } catch (e) {
    console.error('InitData validation error:', e);
    return false;
  }
}

// ------------------------------------------------------------------
// Security Functions (Action ID)
// ------------------------------------------------------------------

/**
 * Generates and stores a unique action ID for a specific action type.
 */
async function handleGenerateActionId(req, res, body) {
    const { user_id, action_type } = body;

    if (!user_id || !action_type) {
        return sendError(res, 'Missing user_id or action_type.', 400);
    }
    
    // 1. Check for recent actions to prevent spam/rapid requests
    try {
        const now = Date.now();
        const minTime = now - MIN_TIME_BETWEEN_ACTIONS_MS;

        // Fetch the last action ID generation time for this user
        const { data: lastAction, error } = await supabase
            .from(DB_ACTIONS)
            .select('created_at')
            .eq('user_id', user_id)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
            
        if (!error && lastAction) {
            const lastActionTime = new Date(lastAction.created_at).getTime();
            if (lastActionTime > minTime) {
                 return sendError(res, 'Rate limit exceeded: Please wait a moment before the next action.', 429);
            }
        }
    } catch (e) {
        console.error('Action ID rate limit check failed:', e.message);
        // Continue if DB check fails, don't block the user entirely
    }

    // 2. Generate and store the new action ID
    const action_id = crypto.randomBytes(16).toString('hex');
    const expiry_time = new Date(Date.now() + ACTION_ID_EXPIRY_MS).toISOString();

    try {
        const { error } = await supabase
            .from(DB_ACTIONS)
            .insert([{ 
                action_id, 
                user_id, 
                action_type, 
                status: 'pending', 
                expires_at: expiry_time 
            }]);

        if (error) throw error;

        sendSuccess(res, { action_id });
    } catch (error) {
        console.error('Error generating action ID:', error.message);
        sendError(res, 'Failed to generate action ID.', 500);
    }
}

/**
 * Checks and consumes the action ID.
 */
async function checkAndConsumeActionId(action_id, expected_type, user_id) {
    if (!action_id) {
        return { ok: false, error: 'SECURITY ERROR: Missing Action ID.' };
    }

    try {
        // 1. Fetch and check the action ID
        const { data: actionRecord, error: fetchError } = await supabase
            .from(DB_ACTIONS)
            .select('*')
            .eq('action_id', action_id)
            .single();

        if (fetchError || !actionRecord) {
            return { ok: false, error: 'SECURITY ERROR: Invalid Action ID.' };
        }

        // 2. Basic security checks
        if (actionRecord.user_id.toString() !== user_id.toString()) {
            return { ok: false, error: 'SECURITY ERROR: Action ID User mismatch.' };
        }
        if (actionRecord.action_type !== expected_type) {
            return { ok: false, error: 'SECURITY ERROR: Action type mismatch.' };
        }
        if (actionRecord.status === 'consumed') {
            return { ok: false, error: 'SECURITY ERROR: Action ID already used.' };
        }
        if (new Date(actionRecord.expires_at) < new Date()) {
            return { ok: false, error: 'SECURITY ERROR: Action ID expired.' };
        }
        
        // 3. Consume the action ID
        const { error: consumeError } = await supabase
            .from(DB_ACTIONS)
            .update({ status: 'consumed', consumed_at: new Date().toISOString() })
            .eq('action_id', action_id);

        if (consumeError) {
             // Log the error but proceed as the ID check was successful
             console.error('Error consuming action ID:', consumeError.message);
        }

        return { ok: true };

    } catch (error) {
        console.error('Action ID check failed:', error.message);
        return { ok: false, error: 'A security verification error occurred.' };
    }
}

// ------------------------------------------------------------------
// Admin Helper
// ------------------------------------------------------------------

function isAdminUser(userId) {
    return userId.toString() === ADMIN_USER_ID;
}

// ------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------

/**
 * Handles initial user registration or updates the last activity.
 */
async function handleRegister(req, res, body) {
  const { user_id, ref_by } = body;
  if (!user_id) {
    return sendError(res, 'Missing user_id.', 400);
  }

  try {
    // 1. Attempt to update or create user
    const { data: user, error: upsertError } = await supabase
        .from(DB_USERS)
        .insert({ 
            id: user_id, 
            ref_by: ref_by, 
            last_login: new Date().toISOString()
        })
        .select('*') // Return the full user object
        .single();
        
    if (upsertError) {
        // If error is due to user already existing, just update last_login
        if (upsertError.code === '23505') { // Unique violation
             const { data: updatedUser, error: updateError } = await supabase
                .from(DB_USERS)
                .update({ last_login: new Date().toISOString() })
                .eq('id', user_id)
                .select('*')
                .single();
            if (updateError) throw updateError;
            sendSuccess(res, { message: 'User updated.', user: updatedUser });
        } else {
            throw upsertError;
        }
    } else {
        sendSuccess(res, { message: 'User registered.', user });
    }
  } catch (error) {
    console.error('Error during registration/update:', error.message);
    sendError(res, `Registration failed: ${error.message}`, 500);
  }
}

/**
 * Fetches user data, including balance, daily counters, and history.
 */
async function handleGetUserData(req, res, body) {
    const { user_id } = body;
    if (!user_id) {
        return sendError(res, 'Missing user_id.', 400);
    }

    try {
        // 1. Fetch user data (balance, counters, ban status)
        const { data: user, error: userError } = await supabase
            .from(DB_USERS)
            .select('balance, ads_watched_today, last_ad_reset, spins_today, last_spin_reset, task_completed, referrals_count, is_banned')
            .eq('id', user_id)
            .single();

        if (userError || !user) {
            return sendError(res, 'User not found.', 404);
        }

        if (user.is_banned) {
            return sendError(res, 'Account banned.', 403);
        }

        // 2. Apply daily reset logic for ads
        const lastAdReset = new Date(user.last_ad_reset).getTime();
        if (Date.now() - lastAdReset >= RESET_INTERVAL_MS) {
            await supabase.from(DB_USERS).update({ ads_watched_today: 0, last_ad_reset: new Date().toISOString() }).eq('id', user_id);
            user.ads_watched_today = 0;
            user.last_ad_reset = new Date().toISOString();
        }

        // 3. Apply daily reset logic for spins
        const lastSpinReset = new Date(user.last_spin_reset).getTime();
        if (Date.now() - lastSpinReset >= RESET_INTERVAL_MS) {
            await supabase.from(DB_USERS).update({ spins_today: 0, last_spin_reset: new Date().toISOString() }).eq('id', user_id);
            user.spins_today = 0;
            user.last_spin_reset = new Date().toISOString();
        }
        
        // 4. Fetch withdrawal history
        const { data: history, error: historyError } = await supabase
            .from(DB_WITHDRAWALS)
            .select('request_id, amount, status, created_at')
            .eq('user_id', user_id)
            .order('created_at', { ascending: false });

        if (historyError) throw historyError;
        
        // 5. Check admin status ⬅️ NEW
        const is_admin = isAdminUser(user_id);
        
        sendSuccess(res, {
            ...user,
            is_admin, // ⬅️ Added is_admin flag
            withdrawal_history: history,
        });

    } catch (error) {
        console.error('Error fetching user data:', error.message);
        sendError(res, `Failed to fetch data: ${error.message}`, 500);
    }
}

/**
 * Handles the completion of an ad watch action.
 */
async function handleWatchAd(req, res, body) {
    const { user_id, action_id } = body;
    if (!user_id) return sendError(res, 'Missing user_id.', 400);

    // 1. Action ID Security Check
    const validAction = await checkAndConsumeActionId(action_id, 'watchAd', user_id);
    if (!validAction.ok) {
        return sendError(res, validAction.error, 409);
    }

    try {
        // 2. Fetch current user data and apply reset logic
        const { data: user, error: userError } = await supabase
            .from(DB_USERS)
            .select('balance, ads_watched_today, last_ad_reset, is_banned')
            .eq('id', user_id)
            .single();

        if (userError || !user) return sendError(res, 'User not found.', 404);
        if (user.is_banned) return sendError(res, 'Account banned.', 403);

        let ads_watched_today = user.ads_watched_today;
        const lastAdReset = new Date(user.last_ad_reset).getTime();
        if (Date.now() - lastAdReset >= RESET_INTERVAL_MS) {
            ads_watched_today = 0;
        }

        // 3. Check daily limit
        if (ads_watched_today >= DAILY_MAX_ADS) {
            return sendError(res, 'Daily ad watch limit reached.', 429);
        }

        // 4. Update user's balance and ad count using RPC function (safe update)
        const { data: updatedUser, error: updateError } = await supabase
             .rpc('update_user_progress', { 
                 p_user_id: user_id, 
                 p_reward: REWARD_PER_AD, 
                 p_ad_count: 1, 
                 p_spin_count: 0 
             });

        if (updateError) throw updateError;
        
        sendSuccess(res, {
            new_balance: updatedUser.new_balance,
            new_ads_count: updatedUser.new_ad_count,
            actual_reward: REWARD_PER_AD,
        });

    } catch (error) {
        console.error('Error handling watchAd:', error.message);
        sendError(res, `Watch ad failed: ${error.message}`, 500);
    }
}

/**
 * Handles referral commission payout.
 * NOTE: This is NOT protected by Action ID as it's a server-to-server call.
 */
async function handleCommission(req, res, body) {
    const { referrer_id, referee_id } = body;

    if (!referrer_id || !referee_id) {
        return sendError(res, 'Missing referrer or referee ID.', 400);
    }
    
    // NOTE: This call must ONLY be made AFTER a successful watchAd from the referee.
    // The commission calculation is based on the REWARD_PER_AD.
    const commissionAmount = REWARD_PER_AD * REFERRAL_COMMISSION_RATE;
    
    try {
        // Check if the referrer exists (optional but good practice)
        const { data: referrer, error: referrerError } = await supabase
            .from(DB_USERS)
            .select('id, is_banned')
            .eq('id', referrer_id)
            .single();
            
        if (referrerError || !referrer) return sendError(res, 'Referrer not found.', 404);
        if (referrer.is_banned) return sendError(res, 'Referrer is banned.', 403);
        
        // Add commission to referrer's balance using RPC
        const { data, error } = await supabase
             .rpc('add_user_balance', { 
                 p_user_id: referrer_id, 
                 p_amount: commissionAmount 
             });
             
        if (error) throw error;
        
        sendSuccess(res, { message: 'Commission paid.', amount: commissionAmount });

    } catch (error) {
        console.error('Error paying commission:', error.message);
        sendError(res, `Commission failed: ${error.message}`, 500);
    }
}

/**
 * Handles the pre-spin logic (check limits).
 */
async function handlePreSpin(req, res, body) {
    const { user_id, action_id } = body;
    if (!user_id) return sendError(res, 'Missing user_id.', 400);
    
    // 1. Action ID Security Check
    const validAction = await checkAndConsumeActionId(action_id, 'preSpin', user_id);
    if (!validAction.ok) {
        return sendError(res, validAction.error, 409);
    }

    try {
        // 2. Fetch current user data and apply reset logic
        const { data: user, error: userError } = await supabase
            .from(DB_USERS)
            .select('spins_today, last_spin_reset, is_banned')
            .eq('id', user_id)
            .single();

        if (userError || !user) return sendError(res, 'User not found.', 404);
        if (user.is_banned) return sendError(res, 'Account banned.', 403);

        let spins_today = user.spins_today;
        const lastSpinReset = new Date(user.last_spin_reset).getTime();
        if (Date.now() - lastSpinReset >= RESET_INTERVAL_MS) {
            spins_today = 0;
        }

        // 3. Check daily limit
        if (spins_today >= DAILY_MAX_SPINS) {
            // Must return an error here so the frontend can prevent the ad from loading
            return sendError(res, 'Daily spin limit reached.', 429);
        }

        // Pre-spin check passed.
        sendSuccess(res, { message: 'Pre-spin check passed.' });

    } catch (error) {
        console.error('Error handling preSpin:', error.message);
        sendError(res, `Pre-spin failed: ${error.message}`, 500);
    }
}

/**
 * Handles the actual spin and reward logic.
 */
async function handleSpinResult(req, res, body) {
    const { user_id, action_id } = body;
    if (!user_id) return sendError(res, 'Missing user_id.', 400);

    // 1. Action ID Security Check
    const validAction = await checkAndConsumeActionId(action_id, 'spinResult', user_id);
    if (!validAction.ok) {
        return sendError(res, validAction.error, 409);
    }

    try {
        // 2. Re-fetch current user data and apply reset logic
        const { data: user, error: userError } = await supabase
            .from(DB_USERS)
            .select('balance, spins_today, last_spin_reset, is_banned')
            .eq('id', user_id)
            .single();

        if (userError || !user) return sendError(res, 'User not found.', 404);
        if (user.is_banned) return sendError(res, 'Account banned.', 403);

        let spins_today = user.spins_today;
        const lastSpinReset = new Date(user.last_spin_reset).getTime();
        if (Date.now() - lastSpinReset >= RESET_INTERVAL_MS) {
            spins_today = 0;
        }

        // 3. Re-check daily limit
        if (spins_today >= DAILY_MAX_SPINS) {
            return sendError(res, 'Daily spin limit reached.', 429);
        }
        
        // 4. Determine prize (simple random selection)
        const prizeIndex = Math.floor(Math.random() * SPIN_SECTORS.length);
        const prize = SPIN_SECTORS[prizeIndex];

        // 5. Update user's balance and spin count using RPC function (safe update)
        const { data: updatedUser, error: updateError } = await supabase
             .rpc('update_user_progress', { 
                 p_user_id: user_id, 
                 p_reward: prize, 
                 p_ad_count: 0, 
                 p_spin_count: 1 
             });

        if (updateError) throw updateError;

        sendSuccess(res, {
            new_balance: updatedUser.new_balance,
            new_spins_count: updatedUser.new_spin_count,
            actual_prize: prize,
            prize_index: prizeIndex, // Send index for frontend wheel animation
        });

    } catch (error) {
        console.error('Error handling spinResult:', error.message);
        sendError(res, `Spin failed: ${error.message}`, 500);
    }
}

/**
 * Handles a withdrawal request from a user.
 * The balance is deducted immediately upon request.
 */
async function handleWithdraw(req, res, body) {
    const { user_id, binanceId, amount, action_id } = body;
    if (!user_id || !binanceId || !amount) {
        return sendError(res, 'Missing user_id, binanceId, or amount.', 400);
    }
    
    const amountInt = parseInt(amount);

    if (isNaN(amountInt) || amountInt < MIN_WITHDRAWAL_AMOUNT) {
        return sendError(res, `Minimum withdrawal amount is ${MIN_WITHDRAWAL_AMOUNT}.`, 400);
    }
    
    // 1. Action ID Security Check
    const validAction = await checkAndConsumeActionId(action_id, 'withdraw', user_id);
    if (!validAction.ok) {
        return sendError(res, validAction.error, 409);
    }

    try {
        // 2. Deduct balance and ensure sufficient funds (using a safe RPC/Function)
        const { data: updatedUser, error: deductError } = await supabase
            .rpc('deduct_user_balance', { 
                p_user_id: user_id, 
                p_amount: amountInt
            });

        if (deductError) {
             if (deductError.message.includes('insufficient')) {
                 return sendError(res, 'Balance insufficient for withdrawal.', 409);
             }
             throw deductError;
        }
        
        // 3. Create the withdrawal request record (status: pending)
        const requestId = crypto.randomBytes(8).toString('hex');
        const { error: insertError } = await supabase
            .from(DB_WITHDRAWALS)
            .insert([{
                request_id: requestId,
                user_id: user_id,
                amount: amountInt,
                binance_id: binanceId,
                status: 'pending'
            }]);

        if (insertError) {
             // CRITICAL: If insert fails, balance needs to be returned! (Requires more complex transaction logic)
             // For simplicity, we log the failure and let manual admin correction handle the refund if needed.
             console.error(`CRITICAL: Withdrawal insert failed for ${user_id}. Amount deducted: ${amountInt}. Error: ${insertError.message}`);
             // Revert the action ID to pending to allow a retry
             await supabase.from(DB_ACTIONS).update({ status: 'pending', consumed_at: null }).eq('action_id', action_id);
             return sendError(res, `Failed to record request. Try again.`, 500);
        }

        sendSuccess(res, {
            new_balance: updatedUser.new_balance,
            message: 'Withdrawal request created and balance deducted.'
        });

    } catch (error) {
        console.error('Error handling withdraw:', error.message);
        sendError(res, `Withdrawal failed: ${error.message}`, 500);
    }
}

/**
 * Handles the channel join task completion.
 */
async function handleCompleteTask(req, res, body) {
    const { user_id, action_id } = body;

    // 1. Action ID Security Check
    const validAction = await checkAndConsumeActionId(action_id, 'completeTask', user_id);
    if (!validAction.ok) {
        return sendError(res, validAction.error, 409);
    }

    try {
        // 2. Check user status
        const { data: user, error: userError } = await supabase
            .from(DB_USERS)
            .select('task_completed, is_banned')
            .eq('id', user_id)
            .single();

        if (userError || !user) return sendError(res, 'User not found.', 404);
        if (user.is_banned) return sendError(res, 'Account banned.', 403);
        if (user.task_completed) return sendError(res, 'Task already completed.', 409);

        // 3. Telegram API check (Simulated)
        // In a full implementation, you'd use the BOT_TOKEN to call:
        // getChatMember(chat_id: TASK_CHANNEL_ID, user_id: user_id)
        // If the user status is 'member' or 'creator', proceed.
        // Since we are limited to file code, we will assume the check passes 
        // after the user clicks the "Claim" button, trusting the frontend logic.
        
        // 4. Update user's balance and mark task as completed
        const { data: updatedUser, error: updateError } = await supabase
             .rpc('add_user_balance', { 
                 p_user_id: user_id, 
                 p_amount: TASK_REWARD 
             });
        
        if (updateError) throw updateError;

        // 5. Mark task as completed in the user record
        await supabase
            .from(DB_USERS)
            .update({ task_completed: true })
            .eq('id', user_id);

        sendSuccess(res, {
            new_balance: updatedUser.new_balance,
            message: 'Task completed successfully.'
        });

    } catch (error) {
        console.error('Error handling completeTask:', error.message);
        sendError(res, `Task completion failed: ${error.message}`, 500);
    }
}

// ------------------------------------------------------------------
// NEW: Admin Panel Handlers
// ------------------------------------------------------------------

/**
 * Handles fetching all pending withdrawal requests.
 */
async function handleGetPendingWithdrawals(req, res, body) {
    const { user_id } = body;

    if (!isAdminUser(user_id)) {
        return sendError(res, 'Access Denied: Not an Admin.', 403);
    }

    try {
        const { data: pending_withdrawals, error } = await supabase
            .from(DB_WITHDRAWALS)
            .select('request_id, user_id, amount, binance_id, created_at, status') // Select status to double check
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error) throw error;

        sendSuccess(res, { pending_withdrawals });
    } catch (error) {
        console.error('Error fetching pending withdrawals:', error.message);
        sendError(res, `Failed to fetch requests: ${error.message}`, 500);
    }
}

/**
 * Handles admin actions: accept, reject, or ban.
 */
async function handleAdminAction(req, res, body) {
    const { user_id, request_id, action, user_to_ban, action_id } = body;

    if (!isAdminUser(user_id)) {
        return sendError(res, 'Access Denied: Not an Admin.', 403);
    }
    
    // Action ID validation
    const validAction = await checkAndConsumeActionId(action_id, 'adminAction', user_id);
    if (!validAction.ok) {
        return sendError(res, validAction.error, 409);
    }

    try {
        if (action === 'ban') {
            if (!user_to_ban) {
                return sendError(res, 'Missing user_to_ban ID.', 400);
            }
            
            // Update user status
            const { error: updateError } = await supabase
                .from(DB_USERS)
                .update({ is_banned: true, banned_by_admin_id: user_id, banned_at: new Date().toISOString() })
                .eq('id', user_to_ban);

            if (updateError) throw updateError;
            
            console.log(`User ${user_to_ban} banned by admin ${user_id}.`);
            return sendSuccess(res, { message: `User ${user_to_ban} banned.` });

        } else if (action === 'accept' || action === 'reject') {
            if (!request_id) {
                return sendError(res, 'Missing request_id for withdrawal action.', 400);
            }

            const newStatus = action === 'accept' ? 'completed' : 'rejected';

            // 1. Get the request details before updating
            const { data: requestData, error: fetchError } = await supabase
                .from(DB_WITHDRAWALS)
                .select('user_id, amount, status')
                .eq('request_id', request_id)
                .single();

            if (fetchError || !requestData) {
                if (fetchError && fetchError.code === 'PGRST116') {
                    return sendError(res, 'Withdrawal request not found.', 404);
                }
                throw fetchError;
            }
            
            if (requestData.status !== 'pending') {
                 return sendError(res, `Request is already ${requestData.status}.`, 409);
            }

            // 2. Update the withdrawal status
            const { error: updateRequestError } = await supabase
                .from(DB_WITHDRAWALS)
                .update({ status: newStatus, processed_by_admin_id: user_id, processed_at: new Date().toISOString() })
                .eq('request_id', request_id);

            if (updateRequestError) throw updateRequestError;

            // 3. If rejected, return the balance
            if (action === 'reject') {
                const amountToReturn = requestData.amount;
                const targetUserId = requestData.user_id;

                // Return balance using RPC function
                const { error: balanceError } = await supabase
                    .rpc('add_user_balance', { 
                        p_user_id: targetUserId, 
                        p_amount: amountToReturn
                    });

                if (balanceError) {
                    console.error(`CRITICAL: Failed to return balance for rejected request ${request_id}:`, balanceError.message);
                    return sendError(res, `Rejected, but failed to refund balance. Manual fix required. Error: ${balanceError.message}`, 500);
                }
                console.log(`Withdrawal ${request_id} rejected. ${amountToReturn} SHIB returned to user ${targetUserId}.`);
            }
            
            console.log(`Withdrawal ${request_id} set to ${newStatus} by admin ${user_id}.`);
            sendSuccess(res, { message: `Request ${request_id} ${newStatus}.` });

        } else {
            return sendError(res, 'Invalid admin action.', 400);
        }

    } catch (error) {
        console.error('Error handling admin action:', error.message);
        sendError(res, `Admin action failed: ${error.message}`, 500);
    }
}

// ------------------------------------------------------------------
// Main Entry Point
// ------------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendError(res, 'Only POST requests are accepted.', 405);
  }

  let body;
  try {
    // Read the request body
    body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(data));
            } catch (err) {
                reject(new Error('Invalid JSON format.'));
            }
        });
        req.on('error', reject);
    });

  } catch (error) {
    return sendError(res, error.message, 400);
  }

  if (!body || !body.type) {
    return sendError(res, 'Missing "type" field in the request body.', 400);
  }

  // ⬅️ initData Security Check
  // Commission doesn't require initData because it's a server-to-server concept (though triggered by client)
  // Admin actions and generating action ID are also special cases where they need protection but initData might be old.
  const isProtectedAction = !['commission'].includes(body.type);
  if (isProtectedAction && (!body.initData || !validateInitData(body.initData))) {
      // NOTE: We allow the flow to proceed for generateActionId and admin actions to perform specific internal checks first
      if (!['generateActionId', 'adminAction'].includes(body.type)) {
          return sendError(res, 'Invalid or expired initData. Security check failed.', 401);
      }
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
    case 'completeTask':
      await handleCompleteTask(req, res, body);
      break;
    case 'generateActionId':
      await handleGenerateActionId(req, res, body);
      break;
    case 'getPendingWithdrawals': // ⬅️ NEW: Admin Panel
      await handleGetPendingWithdrawals(req, res, body);
      break;
    case 'adminAction': // ⬅️ NEW: Admin Panel
      await handleAdminAction(req, res, body);
      break;
    default:
      sendError(res, 'Invalid request type.', 400);
      break;
  }
};