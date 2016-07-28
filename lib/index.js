'use strict';

var fs = require('fs');
var path = require('path');

var _ = require('lodash');
var YAML = require('js-yaml');
var glob = require('glob');
var sway = require('sway');

var jpath = require('jsonpath');
var jsonpointer = require('json-pointer');

var express = require('express');
var cors = require('cors');
var statics = require('serve-static');

var baseDir = 'spec/';
var mainFile = baseDir + 'swagger.yaml';
var pathsDir = baseDir + 'paths/';
var definitionsDir = baseDir + 'definitions/';
var codeSamplesDir = baseDir + 'code_samples/';

exports.serve = function (swaggerGenerator) {
  var app = express();
  app.use(cors());

  console.log(require.resolve('swagger-ui'));
  // Route to Swagger UI
  app.use('/swagger-ui/', statics(require.resolve('swagger-ui') + '/../'));

  // Handle `file` parameter
  app.param('file', function (req, res, next, file) {
      req.file = file;
      next();
  });

  app.use('/swagger.json', function (req, res, next) {
    swaggerGenerator(function (errors, swagger) {
      res.setHeader("Content-Type", "application/json");
      res.end(exports.stringify(swagger, {json: true}));
      next();
    });
  });

  app.use('/swagger.yaml', function (req, res, next) {
    swaggerGenerator(function (errors, swagger) {
      res.setHeader("Content-Type", "application/yaml");
      res.end(exports.stringify(swagger, {yaml: true}));
      next();
    });
  });

  // Error handler
  app.use(function(err, req, res, next) {
      console.error(err.stack);
      res.status(500).json({'error' : err.message});
      next(err);
  });

  // Run server
  app.listen(3000);
}

exports.bundle = function (cb) {
  var swagger = readYaml(mainFile);

  console.log('Adding paths to spec');
  var pathsObj = globObject(pathsDir)
  if (swagger.paths && !_.isEmpty(pathsObj))
    throw Error('All paths should be defined inside ' + pathsDir);
  swagger.paths = _.mapKeys(pathsObj,function(value, key) {
    return '/' + key.replace(/@/g,'/');
  });

  console.log('Adding definitions to spec');
  var definitionsObj = globObject(definitionsDir);
  if (swagger.definitions && !_.isEmpty(definitionsObj))
    throw Error('All definitions should be defined inside ' + definitionsDir);
  swagger.definitions = definitionsObj;

  if (swagger.headers) {
    console.log('Inlining headers referencess');
    inlineHeaders(swagger);
  }

  var codeSamples = globCodeSamples(codeSamplesDir);
  _(codeSamples).keys().sort().each(function (language) {
    _.each(codeSamples[language], function (pathSamples, path) {
      path = '/' + path;
      var swaggerPath = swagger.paths[path];

      if (_.isUndefined(swaggerPath))
        throw Error('Code sample for non-existing path: ' + path);

      _.each(pathSamples, function (opSample, verb) {
        var swaggerOperation = swaggerPath[verb];

        if (_.isUndefined(swaggerOperation))
          throw Error('Code sample for non-existing operation: "' + path + '",' + verb);

        swaggerOperation['x-code-samples'] = swaggerOperation['x-code-samples'] || [];
        swaggerOperation['x-code-samples'].push({lang: language, source: opSample});
      });
    });
  });

  return swagger;
}

exports.stringify = function (swagger, options) {
  if (options.yaml)
    return YAML.safeDump(swagger, {indent: 2, lineWidth: -1});

  return JSON.stringify(swagger, null, 2) + '\n';
};

exports.validate = function (swagger, cb) {
  sway.create({definition: swagger})
  .then(function (swaggerObj) {
    return cb(null, swaggerObj.validate());
  }, function (error) {
    cb(error);
  });
}

function globCodeSamples(dir) {
  var files = glob.sync(dir + '*/*/*');
  var object = {};

  _.each(files, function (file) {
    var parsed = path.parse(file);
    var pathComponents = parsed.dir.split(path.sep);
    var language = pathComponents[pathComponents.length - 2];
    var opPath = pathComponents[pathComponents.length - 1];
    var opVerb = parsed.name;

    object[language] = object[language] || {};
    object[language][opPath] = object[language][opPath] || {};
    object[language][opPath][opVerb] = fs.readFileSync(file, 'utf-8');
  });

  return object;
}

function inlineHeaders(swagger) {
  _.each(jpath.nodes(swagger, '$..*["$ref"]'), function(result) {
    var ref = result.value;
    var parent, resolved;
    if (ref.startsWith('#/headers')) {
      parent = jpath.value(swagger, jpath.stringify(_.dropRight(result.path)));
      delete parent['$ref'];
      resolved = jsonpointer.get(swagger, ref.substring(1));
      _.extend(parent, resolved);
    }
  });
  delete swagger.headers;
}

function globObject(dir) {
  var files = glob.sync(dir + '**/*.yaml');
  var object = {};
  _.each(files, function (file) {
    var name = path.parse(file).name;
    if (name in object) {
      throw new Error(name + " definition already exists");
    }

    object[name] = readYaml(file);
  });
  return object;
}

function readYaml(file) {
  return YAML.safeLoad(fs.readFileSync(file, 'utf-8'), {json: true});
}
