var Docker = require("dockerode");
var docker = new Docker();
var Promise = require("bluebird");
var _ = require("lodash");
var http = require("http");
var fs = require("fs");
var spawn = require("child_process").spawn;
var exec = require("child_process").exec;
var url = require("url");
var path = require("path");

var nginx = spawn("nginx", ["-g", "daemon off;"]);

var inputFile = "nginx.tmpl";
var outputFile = "/etc/nginx/conf.d/default.conf";

var inputTemplate = _.template(fs.readFileSync(inputFile));

var listPr = Promise.promisify(docker.listContainers, docker);
var inspectPr = (c) => {
  var container = docker.getContainer(c.Id);
  return Promise.promisify(container.inspect, container)();
};

function splitENV(envstr){
  var i = envstr.indexOf("=");
  return [ envstr.substr(0, i), envstr.substr(i+1) ];
}

function parse(cinfo){
  var name = cinfo.Name.substr(1);
  var ns = cinfo.NetworkSettings;
  var env = _(cinfo.Config.Env).map(splitENV).zipObject().value();
  var ports = _(ns.Ports).keys().filter( k => k.endsWith("/tcp") )
                 .map( k => k.split(/\//)[0] ).value();
  if(!env.VIRTUAL_HOST){
    return null;
  }else if(ports.length == 0){
    console.error(name + ": No exposed ports from container.");
    return null;
  }else if(ports.length > 1){
    console.error(name + ": More than one exposed ports from container.");
    return null;
  }else{
    return {
      vhost: env.VIRTUAL_HOST,
      dest: ns.IPAddress + ":" + ports[0]
    }
  }
}

function getPr(url) {
  return new Promise( (resolve, reject) => {
    var proxyReq = http.request(url,function(proxyRes){
      var status = proxyRes.statusCode;
      var reply = "";  
      proxyRes.on("data", chunk => reply += chunk.toString());
      proxyRes.on("end", () => {
        if(status == 200) resolve(reply);
        else reject("status code " + status + " " + reply.substr(0, 100).replace(/\n/g, " "));
      });
    });
    proxyReq.on("error", reject);
    proxyReq.end();
  });
}

var lastActive = {};
function checkHealth(cinfo){
  var key = cinfo.destIP + ":" + cinfo.destPort;
  return getPr("http://" + cinfo.dest + "/health/check")
    .then( reply => {
      var healthKey = cinfo.vhost + "/" + cinfo.dest;
      if(reply == "up"){
        lastActive[healthKey] = Date.now();
      }else if(reply == "down"){
        delete lastActive[healthKey];
      }else {
        console.error(healthKey + ": unknown reply " + reply.substr(0, 100))
      }
    })
    .catch( err => {
      console.error(cinfo.vhost + "=>" + cinfo.dest + " down " + err);
    })
}

function getSSL(hosts){
  var ssl = {};
  Object.keys(hosts).forEach( vhost => {
    var crtFile = path.resolve("/certs", vhost + ".crt");
    var keyFile = path.resolve("/certs", vhost + ".key");
    if( fs.existsSync(crtFile) && fs.existsSync(keyFile) ){
      ssl[vhost] = { crt: crtFile, key: keyFile }
    }
  });
  return ssl;
}

var oldConf = null;
function monitor(){
  listPr()
    .map( inspectPr )
    .map( parse )
    .then( _.filter )
    .map( checkHealth )
    .then( () => {
      var fewMomentsAgo = Date.now() - 7000;
      var hostsMap = _(lastActive)
        .pairs()
        .filter( p => p[1] >= fewMomentsAgo )
        .map( p => p[0] )
        .groupBy( healthKey => healthKey.split(/\//)[0] )
        .mapValues( v => _.map(v, healthKey => healthKey.split(/\//)[1]) )
        .value();
      if( Object.keys(hostsMap).length || oldConf ){
        var newConf = inputTemplate({hostsMap: hostsMap, ssl: getSSL(hostsMap) });
        if(oldConf != newConf && nginx){
          fs.writeFileSync(outputFile, newConf);
          console.log("vhosts Updated " + JSON.stringify(hostsMap).trim() );
          oldConf = newConf;
          if(nginx){
            reloadCmd = "nginx -s reload";
            exec(reloadCmd, function(err, sout, serr){
              if(sout) console.log(sout.trim());
              if(serr) console.error(serr.trim());
            });
          }
        }
      }
    })
    .catch( err => console.error("Unable to generate configuration. " + err) );
}

var timer = setInterval(monitor, 2000);


function shutdown(){ 
  console.log("Shutting down monitor, sending SIGTERM to nginx");
  if(timer) clearInterval(timer);
  timer = 0;
  if(nginx) nginx.kill("SIGTERM");
  nginx = null;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);