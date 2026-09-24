import axios from 'axios';

function resolveApiBaseUrl() {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  if (import.meta.env.VITE_API_BASE_URL) {
    return `${import.meta.env.VITE_API_BASE_URL.replace(/\/+$/, '')}/api`;
  }
  return '/api';
}

export const apiClient = axios.create({
  baseURL: resolveApiBaseUrl(),
  withCredentials: true,
});

// --- Offline retry queue ---
// Idempotent GET requests that fail with a network error while the app is
// offline are queued here and replayed when connectivity returns
// (NetworkStatusContext calls retryQueuedRequests on reconnect).
const retryQueue = [];

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const config = error.config;
    if (!error.response && config && config.method === 'get' && !config._retried) {
      config._retried = true;
      retryQueue.push(() => apiClient.request(config));
    }
    return Promise.reject(error);
  }
);

export function retryQueuedRequests() {
  const queue = [...retryQueue];
  retryQueue.length = 0;
  for (const replay of queue) {
    replay().catch(() => { /* replayed request failed again — drop it */ });
  }
}

export const api = {
  async getPlatformConfig() {
    const res = await apiClient.get('/governance/fee');
    return res.data;
  },
  async getFeaturedCampaigns() {
    const res = await apiClient.get('/campaigns/featured');
    return res.data;
  },
  async getCampaigns(params) {
    const res = await apiClient.get('/campaigns', { params });
    return res.data;
  },
  async getCampaignCategories() {
    const res = await apiClient.get('/campaigns/categories');
    return res.data;
  },
  async getCampaignFacets() {
    const res = await apiClient.get('/campaigns/facets');
    return res.data;
  },
  async getRecommendedCampaigns(params) {
    const res = await apiClient.get('/campaigns/recommended', { params });
    return res.data;
  },
  async getCampaign(id) {
    const res = await apiClient.get(`/campaigns/${id}`);
    return res.data;
  },
  async getReferralProgram(id) {
    const res = await apiClient.get(`/campaigns/${id}/referrals/program`);
    return res.data;
  },
  async createReferralLink(id) {
    const res = await apiClient.post(`/campaigns/${id}/referrals/links`);
    return res.data;
  },
  async getCreatorCampaignAnalytics(campaignId) {
    const res = await apiClient.get(`/creator/campaigns/${campaignId}`);
    return res.data;
  },
  async exportCreatorCampaignData(campaignId) {
    const res = await apiClient.get(`/creator/campaigns/${campaignId}/export`, { responseType: 'blob' });
    const disposition = res.headers['content-disposition'] || '';
    let filename = 'campaign-export.csv';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
    return { blob: res.data, filename };
  },
  async exportCampaignReport(campaignId) {
    const res = await apiClient.get(`/campaigns/${campaignId}/report/export`, { responseType: 'blob' });
    const disposition = res.headers['content-disposition'] || '';
    let filename = 'campaign-report.pdf';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
    return { blob: res.data, filename };
  },
  async getCampaignVelocity(campaignId) {
    const res = await apiClient.get(`/creator/campaigns/${campaignId}/velocity`);
    return res.data;
  },
  async updateVelocityThreshold(campaignId, threshold) {
    const res = await apiClient.patch(`/creator/campaigns/${campaignId}/velocity/threshold`, { threshold });
    return res.data;
  },
  async getNotificationPreferences() {
    const res = await apiClient.get('/users/me/notification-preferences');
    return res.data;
  },
  async updateNotificationPreference(data) {
    const res = await apiClient.patch('/users/me/notification-preferences', data);
    return res.data;
  },
  async unsubscribeEmail(data) {
    const res = await apiClient.get('/emails/unsubscribe', { params: data });
    return res.data;
  },
  async getChannelSettings() {
    const res = await apiClient.get('/users/me/channel-settings');
    return res.data;
  },
  async updateChannelSettings(data) {
    const res = await apiClient.patch('/users/me/channel-settings', data);
    return res.data;
  },
  async getPushSubscriptionStatus() {
    const res = await apiClient.get('/users/me/push-subscription');
    return res.data;
  },
  async registerPushSubscription(token) {
    const res = await apiClient.post('/users/me/push-subscription', { token });
    return res.data;
  },
  async removePushSubscription(token) {
    const res = await apiClient.delete('/users/me/push-subscription', { data: { token } });
    return res.data;
  },
  async getMyCampaigns(params) {
    const res = await apiClient.get('/users/me/campaigns', { params });
    return res.data;
  },

  async getAdminAuditLogs(params) {
    const res = await apiClient.get('/admin/audit-logs', { params });
    return res.data;
  },

  async exportAdminAuditLogsCsv(params) {
    const res = await apiClient.get('/admin/audit-logs/export.csv', { params, responseType: 'blob' });
    const disposition = res.headers['content-disposition'] || '';
    let filename = 'audit-logs.csv';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
    return { blob: res.data, filename };
  },

  async exportAdminAuditLogsJson(params) {
    const res = await apiClient.get('/admin/audit-logs/export.json', { params, responseType: 'blob' });
    const disposition = res.headers['content-disposition'] || '';
    let filename = 'audit-logs.json';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
    return { blob: res.data, filename };
  },
  async getNotifications() {
    const res = await apiClient.get('/users/me/notifications');
    return res.data;
  },
  async markNotificationRead(id) {
    const res = await apiClient.patch(`/users/me/notifications/${id}/read`);
    return res.data;
  },
  async markAllNotificationsRead() {
    const res = await apiClient.patch('/users/me/notifications/read-all');
    return res.data;
  },
  async getMyBadges() {
    const res = await apiClient.get('/users/me/badges');
    return res.data;
  },
  async getMyNftRewards() {
    const res = await apiClient.get('/users/me/nft-rewards');
    return res.data;
  },
  async setup2FA() {
    const res = await apiClient.post('/users/me/2fa/setup');
    return res.data;
  },
  async verify2FA({ code }) {
    const res = await apiClient.post('/users/me/2fa/verify', { code });
    return res.data;
  },
  async listCampaignPools(campaignId) {
    const res = await apiClient.get(`/campaign-pools/campaign/${campaignId}`);
    return res.data;
  },
  async createPool({ campaign_id, title, description, target_amount, expires_at }) {
    const res = await apiClient.post('/campaign-pools', {
      campaign_id,
      title,
      description,
      target_amount,
      expires_at,
    });
    return res.data;
  },
  async joinPool(poolId, shareAmount, displayName) {
    const res = await apiClient.post(`/campaign-pools/${poolId}/join`, {
      share_amount: shareAmount,
      display_name: displayName,
    });
    return res.data;
  },
  async leavePool(poolId) {
    const res = await apiClient.post(`/campaign-pools/${poolId}/leave`);
    return res.data;
  },
  async submitPool(poolId) {
    const res = await apiClient.post(`/campaign-pools/${poolId}/submit`);
    return res.data;
  },
};
