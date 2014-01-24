var _ = require('underscore');
var path = require('path');
var fs = require('fs');
var files = require('./files.js');
var parseStack = require('./parse-stack.js');
var release = require('./release.js');
var Future = require('fibers/future');

// Exception representing a test failure
var TestFailure = function (reason, details) {
  var self = this;
  self.reason = reason;
  self.details = details || {};
  self.stack = (new Error).stack;
};

// Use this to decorate functions that throw TestFailure. Decorate the
// first function that should not be included in the call stack shown
// to the user.
var markStack = function (f) {
  return parseStack.markTop(f);
};

var Matcher = function () {
  var self = this;
  self.buf = "";
  self.output = "";
  self.ended = false;
  self.matchPattern = null;
  self.matchFuture = null;
  self.matchStrict = null;
};

_.extend(Matcher.prototype, {
  write: function (data) {
    var self = this;
    self.buf += data;
    self.output += data;
    self._tryMatch();
  },

  match: function (pattern, timeout, strict) {
    var self = this;
    if (self.matchFuture)
      throw new Error("already have a match pending?");
    self.matchPattern = pattern;
    self.matchStrict = strict;
    var f = self.matchFuture = new Future;
    self._tryMatch(); // could clear self.matchFuture

    var timer = null;
    if (timeout) {
      timer = setTimeout(function () {
        self.matchPattern = null;
        self.matchStrict = null;
        self.matchFuture = null;
        f['throw'](new TestFailure('match-timeout'));
      }, timeout * 1000);
    }

    try {
      return f.wait();
    } finally {
      if (timer)
        clearTimeout(timer);
    }
  },

  end: function () {
    var self = this;
    self.ended = true;
    self._tryMatch();
  },

  matchEmpty: function () {
    var self = this;

    if (self.buf.length > 0)
      throw new TestFailure('junk-at-end');
  },

  _tryMatch: function () {
    var self = this;

    var f = self.matchFuture;
    if (! f)
      return;

    var ret = null;

    if (self.matchPattern instanceof RegExp) {
      var m = self.buf.match(self.matchPattern);
      if (m) {
        if (self.matchStrict && m.index !== 0)
          f['throw'](new TestFailure('junk-before'));
        ret = m;
        self.buf = self.buf.slice(m.index + m[0].length);
      }
    } else {
      var i = self.buf.indexOf(self.matchPattern);
      if (i !== -1) {
        if (self.matchStrict && i !== 0)
          f['throw'](new TestFailure('junk-before'));
        ret = self.matchPattern;
        self.buf = self.buf.slice(i + self.matchPattern.length);
      }
    }

    if (ret !== null) {
      self.matchFuture = null;
      self.matchStrict = null;
      self.matchPattern = null;
      f['return'](ret);
      return;
    }

    if (self.ended) {
      self.matchFuture = null;
      self.matchStrict = null;
      self.matchPattern = null;
      f['throw'](new TestFailure('no-match', { output: self.output }));
      return;
    }
  }
});

// Represents an install of the tool.

var Sandbox = function () {
  var self = this;
  self.root = files.mkdtemp();
};

_.extend(Sandbox.prototype, {
  run: function (/* arguments */) {
    var self = this;
    return new Run({
      sandbox: self,
      args: _.toArray(arguments)
    });
  }
});


// Represents a test run of the tool. Typically created through the
// run() method on Sandbox.
//
// Options: args, sandbox
var Run = function (options) {
  var self = this;

  if (! _.has(options, 'sandbox'))
    throw new Error("don't construct this object directly");
  self.sandbox = options.sandbox;

  self._args = [];
  self.proc = null;
  self.baseTimeout = 1;
  self.extraTime = 0;

  self.stdoutMatcher = new Matcher;
  self.stderrMatcher = new Matcher;

  self.exitStatus = undefined; // 'null' means failed rather than exited
  self.exitFutures = [];

  self.args.apply(self, options.args || []);
};

// XXX idea is to also add options to create a project directory to
// run it inside, set up credential files that are either freshly
// created or shared..
_.extend(Run.prototype, {
  // Set command-line arguments. This may be called multiple times as
  // long as the run has not yet started (the run starts after the
  // first call to a function that requires it, like match()).
  //
  // Pass as many arguments as you want. Non-object values will be
  // cast to string, and object values will be treated as maps from
  // option names to values.
  args: function (/* arguments */) {
    var self = this;

    if (self.proc)
      throw new Error("already started?");

    _.each(_.toArray(arguments), function (a) {
      if (typeof a !== "object") {
        self._args.push('' + a);
      } else {
        _.each(a, function (value, key) {
          self._args.push("--" + key);
          self._args.push('' + value);
        });
      }
    });
  },

  _exited: function (status) {
    var self = this;

    if (self.exitStatus !== undefined)
      throw new Error("already exited?");

    self.exitStatus = status;
    var exitFutures = self.exitFutures;
    self.exitFutures = null;
    _.each(exitFutures, function (f) {
      f['return']();
    });

    self.stdoutMatcher.end();
    self.stderrMatcher.end();
  },

  _ensureStarted: function () {
    var self = this;

    if (self.proc)
      return;

    var execPath = null;
    if (release.current.isCheckout())
      execPath = path.join(files.getCurrentToolsDir(), 'meteor');
    else
      execPath = path.join(files.getCurrentToolsDir(), 'bin', 'meteor');

    var env = _.clone(process.env);
    _.extend(env, {
      METEOR_SESSION_FILE: path.join(self.sandbox.root, '.meteorsession')
    });

    var child_process = require('child_process');
    self.proc = child_process.spawn(execPath, self._args, {
      env: env
    });

    self.proc.on('close', function (code, signal) {
      if (self.exitStatus === undefined)
        self._exited({ code: code, signal: signal });
    });

    self.proc.on('close', function (code, signal) {
      if (self.exitStatus === undefined)
        self._exited(null);
    });

    self.proc.stdout.setEncoding('utf8');
    self.proc.stdout.on('data', function (data) {
      self.stdoutMatcher.write(data);
    });

    self.proc.stderr.setEncoding('utf8');
    self.proc.stderr.on('data', function (data) {
      self.stderrMatcher.write(data);
    });
  },

  // Wait until we get text on stdout that matches 'pattern', which
  // may be a regular expression or a string. Consume stdout up to
  // that point. If this pattern does not appear after a timeout (or
  // the program exits before emitting the pattern), fail.
  match: markStack(function (pattern, _strict) {
    var self = this;
    self._ensureStarted();

    var timeout = self.baseTimeout + self.extraTime;
    self.extraTime = 0;
    return self.stdoutMatcher.match(pattern, timeout, _strict);
  }),

  // As expect(), but for stderr instead of stdout.
  matchErr: markStack(function (pattern, _strict) {
    var self = this;
    self._ensureStarted();

    var timeout = self.baseTimeout + self.extraTime;
    self.extraTime = 0;
    return self.stderrMatcher.match(pattern, timeout, _strict);
  }),

  // Like match(), but won't skip ahead looking for a match. It must
  // follow immediately after the last thing we matched or read.
  read: markStack(function (pattern) {
    return this.match(pattern, true);
  }),

  // As read(), but for stderr instead of stdout.
  readErr: markStack(function (pattern) {
    return this.matchErr(pattern, true);
  }),

  // Expect the program to exit without anything further being
  // printed on either stdout or stderr.
  expectEnd: markStack(function () {
    var self = this;
    self._ensureStarted();

    var timeout = self.baseTimeout + self.extraTime;
    self.extraTime = 0;
    self.expectExit();

    self.stdoutMatcher.matchEmpty();
    self.stderrMatcher.matchEmpty();
  }),

  // Expect the program to exit with the given (numeric) exit
  // status. Fail if the process exits with a different code, or if
  // the process does not exit after a timeout.
  expectExit: markStack(function (code) {
    var self = this;
    self._ensureStarted();

    if (self.exitStatus === undefined) {
      var timeout = self.baseTimeout + self.extraTime;
      self.extraTime = 0;

      var fut = new Future;
      self.exitFutures.push(fut);
      var timer = setTimeout(function () {
        fut['throw'](new TestFailure('exit-timeout'));
      }, timeout * 1000);

      try {
        fut.wait();
      } finally {
        clearTimeout(timer);
      }
    }

    if (! self.exitStatus)
      throw new TestFailure('spawn-failure');
    if (code !== undefined && self.exitStatus.code !== code) {
      throw new TestFailure('wrong-exit-code', {
        expected: { code: code },
        actual: self.exitStatus
      });
    }
  }),

  // Extend the timeout for the next operation by 'secs' seconds.
  waitSecs: function (secs) {
    var self = this;
    self.extraTime += secs;
  },

  // Send 'string' to the program on its stdin.
  write: function (string) {
    var self = this;
    self._ensureStarted();
    self.proc.stdin.write(string);
  }
});

var Test = function (options) {
  var self = this;
  self.name = options.name;
  self.file = options.file;
  self.fileHash = options.fileHash;
  self.f = options.func;
};

var allTests = null;
var fileBeingLoaded = null;
var fileBeingLoadedHash = null;
var getAllTests = function () {
  if (allTests)
    return allTests;
  allTests = [];

  // Load all files in the 'selftests' directory that end in .js. They
  // are supposed to then call define() to register their tests.
  var testdir = path.join(__dirname, 'selftests');
  var filenames = fs.readdirSync(testdir);
  _.each(filenames, function (n) {
    if (! n.match(/^[^.].*\.js$/)) // ends in '.js', doesn't start with '.'
      return;
    try {
      if (fileBeingLoaded)
        throw new Error("called recursively?");
      fileBeingLoaded = path.basename(n, '.js');

      var fullPath = path.join(testdir, n);
      var contents = fs.readFileSync(fullPath, 'utf8');
      fileBeingLoadedHash =
        require('crypto').createHash('sha1').update(contents).digest('hex');

      require(path.join(testdir, n));
    } finally {
      fileBeingLoaded = null;
      fileBeingLoadedHash = null;
    }
  });

  return allTests;
};

var define = function (name, f) {
  allTests.push(new Test({
    name: name,
    file: fileBeingLoaded,
    fileHash: fileBeingLoadedHash,
    func: f
  }));
};

// options: onlyChanged
var runTests = function (options) {
  var failureCount = 0;

  var tests = getAllTests();

  if (! tests.length) {
    process.stderr.write("No tests defined.\n");
    return 0;
  }

  var testStateFile = path.join(process.env.HOME, '.meteortest');
  var testState;
  if (fs.existsSync(testStateFile))
    testState = JSON.parse(fs.readFileSync(testStateFile, 'utf8'));
  if (! testState || testState.version !== 1)
    testState = { version: 1, lastPassedHashes: {} };

  if (options.onlyChanged) {
    // Filter out tests that haven't changed since they last passed.
    tests = _.filter(tests, function (test) {
      return test.fileHash !== testState.lastPassedHashes[test.file];
    });
  }

  if (! tests.length) {
    process.stderr.write("No tests changed.\n");
    return 0;
  }

  var failuresInFile = {};
  _.each(tests, function (test) {
    process.stderr.write(test.name + "... ");

    // We will clear this later if it turns out that all of the tests
    // in the file didn't pass
    testState.lastPassedHashes[test.file] = test.fileHash;

    var failure = null;
    try {
      test.f();
    } catch (e) {
      if (e instanceof TestFailure) {
        failure = e;
      } else {
        process.stderr.write("exception\n\n");
        throw e;
      }
    }

    if (failure) {
      process.stderr.write("fail!\n");
      failureCount++;
      var frames = parseStack.parse(failure);
      var relpath = path.relative(files.getCurrentToolsDir(),
                                  frames[0].file);
      process.stderr.write("  => " + failure.reason + " at " +
                           relpath + ":" + frames[0].line + "\n");
      if (failure.reason === 'no-match') {
        var lines = failure.details.output.split('\n');
        if (lines[lines.length - 1] === '')
          lines.pop(); // we expect it to end in a newline
        process.stderr.write("  => Last five lines:\n");
        _.each(lines.slice(-5), function (line) {
          process.stderr.write("  |" + line + "\n");
        });
      }
      failuresInFile[test.file] = true;
    } else {
      process.stderr.write("ok\n");
    }
  });

  _.each(_.keys(failuresInFile), function (f) {
    delete testState.lastPassedHashes[f];
  });

  fs.writeFileSync(testStateFile, JSON.stringify(testState), 'utf8');

  if (failureCount === 0) {
    process.stderr.write("\nAll tests passed.\n");
    return 0;
  } else {
    process.stderr.write("\n" + failureCount + " failure" +
                         (failureCount > 1 ? "s" : "") + ".\n");
    return 1;
  }
};


// XXX tests are slow, so we're going to need a good mechanism for
// running particular tests, or previously failing tests, or changed
// tests (!) or something.. OR, have a fast mode (the default unless
// you pass --paranoid) that just reruns main() in-process, rather
// than spawning?? stdio becomes a bit of a mess..

// XXX way of marking tests that need network, so that we can skip
// them when testing on an airplane (well, universe..)

// XXX have the self-test command take a --universe option (to set the
// universe used in the spawned copy of meteor). if you don't set one
// you don't get the tests that talk to servers.

// XXX have a way to fake being offline

// XXX how are we going to test updating and springboarding? it would
// be great if you could do this from a checkout without having to cut
// a release

_.extend(exports, {
  runTests: runTests,
  define: define,
  Sandbox: Sandbox
});
