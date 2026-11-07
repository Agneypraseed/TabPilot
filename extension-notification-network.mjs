import { z } from 'zod';
import { Notifications, notificationInputSchema } from './notifications.mjs';

const notificationKeys = ['TELEGRAM_BOT_TOKEN', 'TABPILOT_TELEGRAM_CHAT_ID', 'RESEND_API_KEY', 'TABPILOT_EMAIL_FROM', 'TABPILOT_EMAIL_TO'];
const requestSchema = z.object({
    env: z.object(Object.fromEntries(notificationKeys.map(key => [key, z.string().max(4000).optional()]))).strict(),
    input: notificationInputSchema,
    telegramApproval: z.boolean().optional()
}).strict();

// Only fixed notification providers can be contacted through this service.
// The background's sender check is the boundary; never accept arbitrary URLs.
export async function sendExtensionNotification(payload, { permissions, fetch: fetcher } = {}) {
    const {env, input, telegramApproval} = requestSchema.parse(payload);
    const service = new Notifications({env, ...(fetcher ? {fetch: fetcher} : {})});
    const status = service.status();
    const channels = [...new Set(input.channels ?? Object.keys(status).filter(name => status[name].configured))];
    if (!channels.length) return service.send(input);
    const results = await Promise.all(channels.map(async channel => {
        const origin = channel === 'telegram' ? 'https://api.telegram.org/*' : 'https://api.resend.com/*';
        if (status[channel].configured && permissions?.contains) {
            let granted;
            try { granted = await permissions.contains({origins: [origin]}); }
            catch { granted = false; }
            if (!granted) return {channel, accepted: false, errorCode: 'HOST_PERMISSION',
                error: `The extension does not have access to ${channel === 'telegram' ? 'Telegram' : 'Resend'}. Use Send test alert in Settings to grant access. No message was sent.`};
        }
        return (await service.send({...input, channels: [channel]}, {telegramApproval})).results[0];
    }));
    return {accepted: results.every(item => item.accepted), results};
}

if (typeof chrome !== 'undefined' && chrome.runtime) {
    globalThis.tabPilotSendNotification = payload => sendExtensionNotification(payload, {permissions: chrome.permissions});
}

export async function checkTelegramConnection(payload, { permissions, fetch: fetcher = fetch } = {}) {
    const {env} = z.object({env: z.object({TELEGRAM_BOT_TOKEN:z.string().max(4000),TABPILOT_TELEGRAM_CHAT_ID:z.string().max(4000)}).strict()}).strict().parse(payload);
    const configured = new Notifications({env}).status().telegram;
    if(!configured.configured)return {ok:false,errorCode:'CONFIGURATION',error:'Check the saved raw bot token and numeric Chat ID. No alert was sent.'};
    if(permissions?.contains) {
        let allowed=false;
        try {allowed=await permissions.contains({origins:['https://api.telegram.org/*']});}catch{}
        if(!allowed)return {ok:false,errorCode:'HOST_PERMISSION',error:'Telegram site access is disabled for this extension. Allow it in the extension’s site-access settings. No alert was sent.'};
    }
    let phase='bot';
    try {
        const base='https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN;
        const auth=await fetcher(base+'/getMe',{method:'GET',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000)});
        if(!auth.ok){await auth.body?.cancel();return {ok:false,errorCode:'BOT_AUTH',error:`Telegram could not verify the saved bot token (HTTP ${auth.status}). Check or replace it. No alert was sent.`};}
        const bot=await auth.json();
        if(bot.ok!==true||bot.result?.is_bot!==true)return {ok:false,errorCode:'BOT_AUTH',error:'Telegram did not verify the saved bot token. No alert was sent.'};
        phase='chat';
        const response=await fetcher(base+'/getChat',{method:'POST',redirect:'error',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:env.TABPILOT_TELEGRAM_CHAT_ID}),signal:AbortSignal.timeout(10000)});
        if(!response.ok){await response.body?.cancel();return {ok:false,errorCode:'CHAT_ACCESS',error:`The bot is valid, but Telegram could not access the saved Chat ID (HTTP ${response.status}). Start the bot in that chat or check its channel access. No alert was sent.`};}
        const chat=await response.json();
        if(chat.ok!==true||!Number.isSafeInteger(chat.result?.id))return {ok:false,errorCode:'CHAT_ACCESS',error:'The bot is valid, but Telegram did not verify the saved chat. No alert was sent.'};
        return {ok:true,message:'Telegram connection verified: the bot is valid and the saved chat is accessible. No alert was sent.'};
    }catch(error){
        const timedOut=['TimeoutError','AbortError'].includes(error?.name);
        return {ok:false,errorCode:timedOut?'TIMEOUT':'NETWORK_ERROR',error:`The browser ${timedOut?'timed out contacting':'could not read a response from'} Telegram while checking the ${phase}. Check extension site access and your network or VPN. No alert was sent.`};
    }
}
if(typeof chrome!=='undefined'&&chrome.runtime)globalThis.tabPilotCheckTelegram=payload=>checkTelegramConnection(payload,{permissions:chrome.permissions});

export async function pollExtensionTelegram(payload, { permissions, fetch: fetcher } = {}) {
    const {env, offset} = z.object({
        env: z.object({TELEGRAM_BOT_TOKEN:z.string().max(4000),TABPILOT_TELEGRAM_CHAT_ID:z.string().max(4000)}).strict(),
        offset: z.number().int().nonnegative().optional()
    }).strict().parse(payload);
    if (permissions?.contains && !await permissions.contains({origins:['https://api.telegram.org/*']}))
        throw new Error('Telegram site access is disabled.');
    return new Notifications({env,fetch:fetcher}).telegramReplies(offset);
}
if(typeof chrome!=='undefined'&&chrome.runtime)globalThis.tabPilotPollTelegram=payload=>pollExtensionTelegram(payload,{permissions:chrome.permissions});
