import {autorun, observable} from "mobx";
import {LS_ACCESS_TOKEN_KEY, LS_USER_KEY, NOT_INITIALIZED_ERROR} from "./constants";
import {getTargetContainer, http, Query} from "./utils";
import defaultTheme from "./theme/default";

const scope = 'public_repo'; // todo add this to app oauth

function extendRenderer(instance, renderer) {
  instance[renderer] = (container) => {
    const targetContainer = getTargetContainer(container);
    const render = instance.theme[renderer] || instance.defaultTheme[renderer];

    autorun(() => {
      const e = render(instance.state, instance);
      if (targetContainer.firstChild) {
        targetContainer.replaceChild(e, targetContainer.firstChild)
      } else {
        targetContainer.appendChild(e)
      }
    });

    return targetContainer
  }
}

class Gitment {
  get accessToken() {
    return localStorage.getItem(LS_ACCESS_TOKEN_KEY)
  }

  constructor(options = {}) {
    this.defaultTheme = defaultTheme;
    this.useTheme(defaultTheme);

    Object.assign(this, {
      id: window.location.href,
      title: window.document.title,
      link: window.location.href,
      desc: '',
      labels: [],
      theme: defaultTheme,
      oauth: {},
      perPage: 20,
      maxCommentHeight: 250,
    }, options);

    this.useTheme(this.theme);

    const user = {};
    try {
      const userInfo = localStorage.getItem(LS_USER_KEY);
      if (this.accessToken && userInfo) {
        Object.assign(user, JSON.parse(userInfo), {
          fromCache: true,
        })
      }
    } catch (e) {
      localStorage.removeItem(LS_USER_KEY);
    }

    this.state = observable({
      user,
      error: null,
      meta: {},
      comments: undefined,
      reactions: [],
      commentReactions: {},
      currentPage: 1,
    });

    const query = Query.parse();
    if (query.code) {
      const {client_id, client_secret} = this.oauth;
      const code = query.code;
      delete query.code;
      const search = Query.stringify(query);
      const replacedUrl = `${window.location.origin}${window.location.pathname}${search}${window.location.hash}`;
      history.replaceState({}, '', replacedUrl);

      Object.assign(this, {
        id: replacedUrl,
        link: replacedUrl,
      }, options);

      this.state.user.isLoggingIn = true;
      http.post('https://gh-oauth.imsun.net', {
          code,
          client_id,
          client_secret,
        }, '')
          .then(() => {
          this.update()
        })
          .catch(() => {
          this.state.user.isLoggingIn = false
        })
    } else {
      this.update()
    }
  }

  init() {
    return this.createIssue()
      .then(() => this.loadComments())
      .then(comments => {
        this.state.error = null;
        return comments;
      })
  }

  useTheme(theme = {}) {
    this.theme = theme;

    const renderers = Object.keys(this.theme);
    renderers.forEach(renderer => extendRenderer(this, renderer));
  }

  update() {
    return Promise.all([this.loadMeta(), this.loadUserInfo()])
      .then(() => Promise.all([
        this.loadComments().then(() => this.loadCommentReactions()),
        this.loadReactions(),
      ]))
      .catch(e => this.state.error = e)
  }

  markdown(text) {
    return http.post('/markdown', {
      text,
      mode: 'gfm',
    })
  }

  createIssue() {
    const {id, owner, repo, title, link, desc, labels} = this;

    return http.post(`/repos/${owner}/${repo}/issues`, {
      title,
      labels: labels.concat(['gitment', id]),
      body: `${link}\n\n${desc}`,
    })
      .then((meta) => {
        this.state.meta = meta;
        return meta;
      })
  }

  getIssue() {
    if (this.state.meta.id) return Promise.resolve(this.state.meta);

    return this.loadMeta()
  }

  post(body) {
    return this.getIssue()
      .then(issue => http.post(issue.comments_url, { body }, ''))
      .then(data => {
        this.state.meta.comments++;
        const pageCount = Math.ceil(this.state.meta.comments / this.perPage);
        if (this.state.currentPage === pageCount) {
          this.state.comments.push(data);
        }
        return data;
      })
  }

  loadMeta() {
    const {id, owner, repo} = this;
    return http.get(`/repos/${owner}/${repo}/issues`, {
        creator: owner,
        labels: id,
      })
      .then(issues => {
        if (!issues.length) return Promise.reject(NOT_INITIALIZED_ERROR);
        this.state.meta = issues[0];
        return issues[0]
      })
  }

  loadComments(page = this.state.currentPage) {
    return this.getIssue()
      .then(issue => http.get(issue.comments_url, { page, per_page: this.perPage }, ''))
      .then((comments) => {
        this.state.comments = comments;
        return comments;
      })
  }

  loadUserInfo() {
    if (!this.accessToken) {
      return Promise.resolve({})
    }

    return http.get('/user')
      .then((user) => {
        this.state.user = user;
        localStorage.setItem(LS_USER_KEY, JSON.stringify(user));
        return user;
      })
  }

  loadReactions() {
    if (!this.accessToken) {
      this.state.reactions = [];
      return Promise.resolve([])
    }

    return this.getIssue()
      .then((issue) => {
        if (!issue.reactions.total_count) return [];
        return http.get(issue.reactions.url, {}, '')
      })
      .then((reactions) => {
        this.state.reactions = reactions;
        return reactions
      })
  }

  loadCommentReactions() {
    if (!this.accessToken) {
      this.state.commentReactions = {};
      return Promise.resolve([]);
    }

    const comments = this.state.comments;
    const comentReactions = {};

    return Promise.all(comments.map((comment) => {
      if (!comment.reactions.total_count) return [];

      const {owner, repo} = this;
      return http.get(`/repos/${owner}/${repo}/issues/comments/${comment.id}/reactions`, {})
    }))
      .then(reactionsArray => {
        comments.forEach((comment, index) => {
          comentReactions[comment.id] = reactionsArray[index]
        });
        this.state.commentReactions = comentReactions;

        return comentReactions
      })
  }

  goto(page) {
    this.state.currentPage = page;
    this.state.comments = undefined;
    return this.loadComments(page);
  }

  like() {
    if (!this.accessToken) {
      return Promise.reject()
    }

    const {owner, repo} = this;

    return http.post(`/repos/${owner}/${repo}/issues/${this.state.meta.number}/reactions`, {
      content: 'heart',
    })
      .then(reaction => {
        this.state.reactions.push(reaction)
        this.state.meta.reactions.heart++
      })
  }

  unlike() {
    if (!this.accessToken) return Promise.reject();

    const {user, reactions} = this.state;
    const index = reactions.findIndex(reaction => reaction.user.login === user.login);
    return http.delete(`/reactions/${reactions[index].id}`)
      .then(() => {
        reactions.splice(index, 1);
        this.state.meta.reactions.heart--
      })
  }

  likeAComment(commentId) {
    if (!this.accessToken) {
      return Promise.reject()
    }

    const {owner, repo} = this;
    const comment = this.state.comments.find(comment => comment.id === commentId);

    return http.post(`/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
      content: 'heart',
    })
      .then(reaction => {
        this.state.commentReactions[commentId].push(reaction);
        comment.reactions.heart++;
      })
  }

  unlikeAComment(commentId) {
    if (!this.accessToken) return Promise.reject();

    const reactions = this.state.commentReactions[commentId];
    const comment = this.state.comments.find(comment => comment.id === commentId);
    const {user} = this.state;
    const index = reactions.findIndex(reaction => reaction.user.login === user.login);

    return http.delete(`/reactions/${reactions[index].id}`)
      .then(() => {
        reactions.splice(index, 1);
        comment.reactions.heart--;
      })
  }
}

module.exports = Gitment;
