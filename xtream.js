// Xtream Codes API istemcisi (web sürümü - tek adres)
class XtreamClient {
  constructor(host, username, password) {
    this.host = host.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
  }

  apiUrl(action, extra = '') {
    return `${this.host}/player_api.php?username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}${action ? '&action=' + action : ''}${extra}`;
  }

  async _getJson(action, extra = '') {
    const url = this.apiUrl(action, extra);
    let res;
    try {
      res = await fetch(url);
    } catch (netErr) {
      throw new Error(`Sunucuya ulaşılamadı (CORS engeli olabilir): ${netErr.message}`);
    }
    if (!res.ok) throw new Error(`Sunucu hatası (${res.status})`);
    const text = await res.text();
    if (!text || !text.trim()) return [];
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Panelden geçersiz cevap (${action})`);
    }
  }

  async authenticate() {
    const data = await this._getJson('');
    if (!data || !data.user_info || data.user_info.auth !== 1) {
      throw new Error('Kullanıcı adı veya şifre hatalı');
    }
    return data;
  }

  async getLiveCategories() { return (await this._getJson('get_live_categories')) || []; }
  async getAllLiveStreams() { return (await this._getJson('get_live_streams')) || []; }
  async getVodCategories() { return (await this._getJson('get_vod_categories')) || []; }
  async getAllVodStreams() { return (await this._getJson('get_vod_streams')) || []; }
  async getVodInfo(vodId) { return (await this._getJson('get_vod_info', `&vod_id=${vodId}`)) || {}; }
  async getSeriesCategories() { return (await this._getJson('get_series_categories')) || []; }
  async getAllSeries() { return (await this._getJson('get_series')) || []; }
  async getSeriesInfo(seriesId) { return (await this._getJson('get_series_info', `&series_id=${seriesId}`)) || {}; }

  liveUrl(streamId, ext = 'm3u8') { return `${this.host}/live/${this.username}/${this.password}/${streamId}.${ext}`; }
  vodUrl(streamId, ext) { return `${this.host}/movie/${this.username}/${this.password}/${streamId}.${ext}`; }
  seriesUrl(episodeId, ext) { return `${this.host}/series/${this.username}/${this.password}/${episodeId}.${ext}`; }
}
