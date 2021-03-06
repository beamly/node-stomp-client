var assert = require('assert');
var net = require('net');
var util = require('util');
var events = require('events');
var StompFrame = require('./frame').StompFrame;
var StompFrameEmitter = require('./parser').StompFrameEmitter;

// Copied from modern node util._extend, because it didn't exist
// in node 0.4.
function _extend(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || typeof add !== 'object') return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

// Inbound frame validators
var StompFrameCommands = {
  '1.0': {
    'CONNECTED': {
      'headers': { 'session': { required: true } }
    },
    'MESSAGE' : {
      'headers': {
        'destination': { required: true },
        'message-id': { required: true }
      }
    },
    'ERROR': {},
    'RECEIPT': {}
  },
  '1.1': {
    'CONNECTED': {
      'headers': { 'version': { required: true } }
    },
    'MESSAGE' : {
      'headers': {
        'destination': { required: true },
        'message-id': { required: true },
        'subscription': { required: true }
      }
    },
    'ERROR': {},
    'RECEIPT': {
      'headers': {
        'receipt-id': { required: true },
      }
    }
  }
};

function StompClient(address, port, user, pass, protocolVersion, clientId) {
  events.EventEmitter.call(this);
  this.user = (user || '');
  this.pass = (pass || '');
  this.address = (address || '127.0.0.1');
  this.port = (port || 61613);
  this.version = (protocolVersion || '1.0');
  this.clientId = (clientId || 'node-stomp-client');
  this.subscriptions = {};
  this.lastSubscriptionId = 0;
  this._stompFrameEmitter = new StompFrameEmitter(StompFrameCommands[this.version]);
}

util.inherits(StompClient, events.EventEmitter);

StompClient.prototype.connect = function (connectedCallback, errorCallback) {
  var self = this;

  if (errorCallback) {
    self.on('error', errorCallback);
  }

  self.stream = net.createConnection(self.port, self.address);
  self.stream.on('connect', function() {
    self.onConnect();
  });

  self.stream.on('error', self.emit.bind(self, 'error'));

  if (connectedCallback) {
    self.on('connect', connectedCallback);
  }
  return this;
};

StompClient.prototype.disconnect = function (callback, errorCallbackToRemove) {
  var self = this;

  // XXX(sam) if no this.stream, never make any callbacks? should probably error

  if (this.stream) {

    this.on('disconnect', function () {

      if (errorCallbackToRemove) {
        this.removeListener('error', errorCallbackToRemove);
      }

    });

    if (callback) {
      this.on('disconnect', callback);
    }

    var frame = new StompFrame({
      command: 'DISCONNECT'
    }).send(this.stream);

    process.nextTick(function() {
      self.stream.end();
    });

  }
  return this;
};

StompClient.prototype.onConnect = function() {

  var self = this;

  // First set up the frame parser
  var frameEmitter = self._stompFrameEmitter;

  self.stream.on('data', function(data) {
    frameEmitter.handleData(data);
  });

  self.stream.on('end', function() {
    self.stream.end();
    process.nextTick(function() {
    self.emit('disconnect');
    });

  });

  frameEmitter.on('MESSAGE', function(frame) {
    var subscribed = self.subscriptions[frame.headers.destination];
    // .unsubscribe() deletes the subscribed callbacks from the subscriptions,
    // but until that UNSUBSCRIBE message is processed, we might still get
    // MESSAGE. Check to make sure we don't call .map() on null.
    if (subscribed) {
      subscribed.map(function(callback) {
        callback(frame.body, frame.headers);
      });
    }
  });

  frameEmitter.on('CONNECTED', function(frame) {
    self.emit('connect', frame.headers.session);
  });

  frameEmitter.on('ERROR', function(frame) {
    var er = new Error(frame.headers.message);
    // frame.headers used to be passed as er, so put the headers on er object
    _extend(er, frame.headers);
    self.emit('error', er, frame.body);
  });

  frameEmitter.on('parseError', function(err) {
    var msg = 'Error Parsing Message: ' + err['message'];
    if (err.hasOwnProperty('details')) {
      msg += ' (' + err['details'] + ')';
    }
  });

  var headers = {
    'login': self.user,
    'passcode': self.pass
  };

  if(this.version === '1.1') {
    headers['accept-version'] = this.version;
    headers['client-id'] = this.clientId;
  }

  // Send the CONNECT frame
  var frame = new StompFrame({
    command: 'CONNECT',
    headers: headers
  }).send(self.stream);
};

StompClient.prototype.subscribe = function(queue, _headers, _callback) {
  // Allow _headers or callback in any order, for backwards compat: so headers
  // is whichever arg is not a function, callback is whatever is left over.
  var callback;
  if (typeof _headers === 'function') {
    callback = _headers;
    _headers = null;
  }
  if (typeof _callback === 'function') {
    callback = _callback;
    _callback = null;
  }
  // Error now, preventing errors thrown from inside the 'MESSAGE' event handler
  assert(callback, 'callback is mandatory on subscribe');

  var headers = _extend({}, _headers || _callback);
  headers.destination = queue;
  if (!(queue in this.subscriptions)) {
    this.subscriptions[queue] = [];
    this.lastSubscriptionId++;
    headers.id = this.lastSubscriptionId;
    new StompFrame({
      command: 'SUBSCRIBE',
      headers: headers
    }).send(this.stream);
  }
  this.subscriptions[queue].push(callback);
  return this;
};

// no need to pass a callback parameter as there is no acknowledgment for
// successful UNSUBSCRIBE from the STOMP server
StompClient.prototype.unsubscribe = function (queue, headers, subscriptionId) {
  headers = _extend({}, headers);
  headers.destination = queue;
  if(subscriptionId != null) {
    headers.id = subscriptionId;
  }
  new StompFrame({
    command: 'UNSUBSCRIBE',
    headers: headers
  }).send(this.stream);
  delete this.subscriptions[queue];
  return this;
};

StompClient.prototype.publish = function(queue, message, headers) {
  headers = _extend({}, headers);
  headers.destination = queue;
  new StompFrame({
    command: 'SEND',
    headers: headers,
    body: message
  }).send(this.stream);
  return this;
};

StompClient.prototype.ack = function(subscriptionId, messageId) {
  new StompFrame({
    command: 'ACK',
    headers: {
      'subscription': subscriptionId,
      'message-id': messageId
    }
  }).send(this.stream);
  return this;
};

StompClient.prototype.nack = function(subscriptionId, messageId) {
  headers = {};
  headers.subscription = subscriptionId;
  headers['message-id'] = messageId;
  new StompFrame({
    command: 'NACK',
    headers: {
      'subscription': subscriptionId,
      'message-id': messageId
    }
  }).send(this.stream);
  return this;
};

function SecureStompClient(address, port, user, pass, credentials) {
  events.EventEmitter.call(this);
  var self = this;
  self.user = user;
  self.pass = pass;
  self.subscriptions = {};
  self.stream = net.createConnection(port, address);
  self.stream.on('connect', function() {
    self.stream.setSecure(credentials);
  });
  self.stream.on('secure', function() {
    self.onConnect();
  });
}

util.inherits(SecureStompClient, StompClient);

exports.StompClient = StompClient;
exports.SecureStompClient = SecureStompClient;
