/* global List */
import Ember from 'ember';
import createPouchViews from 'hospitalrun/utils/pouch-views';
import PouchAdapterUtils from 'hospitalrun/mixins/pouch-adapter-utils';

const { computed } = Ember;

export default Ember.Service.extend(PouchAdapterUtils, {
  config: Ember.inject.service(),
  userRole: computed.readOnly('config.sessionData.authenticated.role'),
  mainDB: computed('userRole', function() {
    let userRole = this.get('userRole');
    if (userRole === 'researcher') {
      return this.get('anonDB');
    }
    return this.get('mainDBDefault');
  }),
  mainDBDefault: null, // Server DB
  anonDB: null, // Anonimized database
  oauthHeaders: null,
  setMainDB: false,

  setup(configs) {
    PouchDB.plugin(List);
    this.createDBWithName('anon', 'anon', configs).then((db) => {
      this.set('anonDB', db);
    });
    return this.createDB(configs)
      .then((db) => {
        this.set('mainDBDefault', db);
        this.set('setMainDB', true);
      });
  },

  createDB(configs) {
    return this.createDBWithName('localMainDB', 'main', configs);
  },

  createDBWithName(localDBName, remoteDBName, configs) {
    return new Ember.RSVP.Promise((resolve, reject) => {
      let pouchOptions = {};
      if (configs && configs.config_use_google_auth) {
        pouchOptions.ajax = {
          timeout: 30000
        };
        // If we don't have the proper credentials, throw error to force login.
        if (Ember.isEmpty(configs.config_consumer_key) ||
          Ember.isEmpty(configs.config_consumer_secret) ||
          Ember.isEmpty(configs.config_oauth_token) ||
          Ember.isEmpty(configs.config_token_secret)) {
          throw Error('login required');
        } else {
          var headers = {
            'x-oauth-consumer-secret': configs.config_consumer_secret,
            'x-oauth-consumer-key': configs.config_consumer_key,
            'x-oauth-token-secret': configs.config_token_secret,
            'x-oauth-token': configs.config_oauth_token
          };
          this.set('oauthHeaders', headers);
          pouchOptions.ajax.headers = headers;
        }
      }
      const url = `${document.location.protocol}//${document.location.host}/db/${remoteDBName}`;

      this._createRemoteDB(url, pouchOptions)
      .catch((err) => {
        if ((err.status && err.status === 401) || configs.config_disable_offline_sync === true) {
          reject(err);
        } else {
          return this._createLocalDB(localDBName, pouchOptions);
        }
      }).then((db) => resolve(db))
      .catch((err) => reject(err));

    }, 'initialize application db');
  },

  queryMainDB(queryParams, mapReduce) {
    return new Ember.RSVP.Promise((resolve, reject) => {
      var mainDB = this.get('mainDB');
      if (mapReduce) {
        mainDB.query(mapReduce, queryParams, (err, response) => {
          if (err) {
            this._pouchError(reject)(err);
          } else {
            response.rows = this._mapPouchData(response.rows);
            resolve(response);
          }
        });
      } else {
        mainDB.allDocs(queryParams, (err, response) => {
          if (err) {
            this._pouchError(reject)(err);
          } else {
            response.rows = this._mapPouchData(response.rows);
            resolve(response);
          }
        });
      }
    });
  },

  /**
  * Given an pouchDB doc id, return the corresponding ember record id.
  * @param {String} docId the pouchDB doc id.
  * @returns {String} the corresponding Ember id.
  */
  getEmberId(docId) {
    var parsedId = this.get('mainDB').rel.parseDocID(docId);
    if (!Ember.isEmpty(parsedId.id)) {
      return parsedId.id;
    }
  },

  getDocFromMainDB(docId) {
    return new Ember.RSVP.Promise((resolve, reject) => {
      var mainDB = this.get('mainDB');
      mainDB.get(docId, (err, doc) => {
        if (err) {
          this._pouchError(reject)(err);
        } else {
          resolve(doc);
        }
      });
    });
  },

  /**
  * Given an Ember record id and type, return back the corresponding pouchDB id.
  * @param {String} emberId the ember record id.
  * @param {String} type the record type.
  * @returns {String} the corresponding pouch id.
  */
  getPouchId(emberId, type) {
    return this.get('mainDB').rel.makeDocID({
      id: emberId,
      type: type
    });
  },

  /**
   * Load the specified db dump into the database.
   * @param {String} dbDump A couchdb dump string produced by pouchdb-dump-cli.
   * @returns {Promise} A promise that resolves once the dump has been loaded.
   */
  loadDBFromDump: function(dbDump) {
    return new Ember.RSVP.Promise((resolve, reject) => {
      var db = new PouchDB('dbdump', {
        adapter: 'memory'
      });
      db.load(dbDump).then(() => {
        var mainDB = this.get('mainDB');
        db.replicate.to(mainDB).on('complete', (info) => {
          resolve(info);
        }).on('error', (err) => {
          reject(err);
        });
      }, reject);
    });
  },

  _mapPouchData(rows) {
    var mappedRows = [];
    if (rows) {
      mappedRows = rows.map((row) => {
        if (row.doc) {
          var rowValues = {
            doc: row.doc.data
          };
          rowValues.doc.id = this.getEmberId(row.id);
          return rowValues;
        } else {
          return row;
        }
      });
    }
    return mappedRows;
  },

  _createRemoteDB(remoteUrl, pouchOptions) {
    return new Ember.RSVP.Promise(function(resolve, reject) {
      new PouchDB(remoteUrl, pouchOptions, (errRemote, remoteDB) => {
        if (errRemote) {
          reject(errRemote);
          return;
        }

        // remote db lazy created, check if db created correctly
        remoteDB.info().then(() => {
          createPouchViews(remoteDB);
          resolve(remoteDB);
        }).catch((err) => reject(err));
      });
    });
  },

  _createLocalDB(localDBName, pouchOptions) {
    return new Ember.RSVP.Promise(function(resolve, reject) {
      new PouchDB(localDBName, pouchOptions, (errLocal, localDB) => {
        if (errLocal) {
          reject(errLocal);
          return;
        }

        createPouchViews(localDB);
        resolve(localDB);
      });
    });
  }
});
