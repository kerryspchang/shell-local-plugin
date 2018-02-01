/*
 * Copyright 2017 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const {Docker} = require('node-docker-api'),    
    docker = new Docker(),
    rt = require('requestretry'),    
    $ = require('jquery'),
    fs = require('fs-extra');

const dontCreateContainer = "don't create container",
    skipInit = "skip initialization",
    dontShutDownContainer = "don't shut down container",
    htmlIncre = '<div style="color: black"><div class="replay_output" style="white-space:pre-wrap;"></div><div class="replay_spinner" style="animation: spin 750ms linear infinite; height:15px; width:10px; margin: 5px 0px 0px 2px;"> | </div></div>',
    debugFileName = 'shell-debug.js',
    debuggerURL = 'chrome-devtools://devtools/bundled/inspector.html?experiments=true&v8only=true&ws=0.0.0.0:5858';

// config for the docker container 
const dockerConfig = {         
    ExposedPorts: {
        "8080/tcp": {}, // 8080 is the port for api communications 
        "5858/tcp": {}  // 5858 is the port for node debugger 
    },
    HostConfig:{
        PortBindings: {
            "8080/tcp": [
                    { "HostPort": "8080"}
            ],
            "5858/tcp": [
                    { "HostPort": "5858"}
            ]
        }
    },
    name: "shell-local"          
};

const uuidPattern = /^[0-9a-f]{32}$/;

 // Docs for the plugin - total four commands     
const docs = {
    overall:  `<div>This plugin lets you run actions in a local Docker container for testing and debugging purposes. <br/>It requires Docker to be pre-installed in your machine.<br/><br/></div>`,
    play: '<div><b>local play <i>action_name_or_activation_id</i> [-p name value]</b>: Run an action or activation locally. When replaying an activation, the plugin will fetch its previous activation (if available) to get the input data. You can also provide the input data with -p. Return the output and execution time.</div>',
    debug: '<div><b>local debug <i>action_name_or_activation_id</i> [-p name value]</b>: **Only for NodeJs** Run an action or activation locally, and open Chrome DevTool in the sidecar for live debugging. Return the output.</div>',
    init: '<div><b>local init <i>action_name</i></b>: Start a Docker container with the runtime image of an action (but not yet execute the action). This command is mostly used internally by Shell.</div>',
    kill: `<div><b>local kill container</b>: Kill and remove the Docker container this plugin uses. This command is mostly used internally by Shell. The container is removed automatically when you exit Shell.</div>`
}



let _container, _containerType, _containerCode, _imageDir, _image;



module.exports = (commandTree, prequire) => {
   
    commandTree.listen('/local', local, {docs: docs.overall});
    commandTree.listen('/local/play', local, {docs: docs.play});
    commandTree.listen('/local/debug', local, {docs: docs.debug});
    commandTree.listen('/local/init', local, {docs: docs.init});
    commandTree.listen('/local/kill', local, {docs: docs.kill});

    if(typeof document === 'undefined') return; 

    
    $(window).on('beforeunload', e => {
        if(_container){
            _container.stop();
            _container.delete({ force: true });
        }        
    });   
}

const local = (_a, _b, fullArgv, _1, rawCommandString, _2, argvWithoutOptions, dashOptions) => {    

    return new Promise((resolve, reject) => {        
        if(argvWithoutOptions.length <= 1){
            resolve(printDocs());
        }
        else if(Object.keys(docs).indexOf(argvWithoutOptions[1]) < 1){
            // missing wil be -1, 'overall' will be 0. so none of that
            resolve(printDocs());
        }
        else if(argvWithoutOptions.length == 2){
            resolve(printDocs(argvWithoutOptions[1]));
        }       
        else{
            let input = {};
            for(var i=2; i<fullArgv.length; i++){
                let addIndex = 0;
                if(fullArgv[i] == '-p' && fullArgv[i+1] && fullArgv[i+1] != '-p'){
                    addIndex++;
                    if(fullArgv[i+2] && fullArgv[i+2] != '-p'){
                        input[fullArgv[i+1]] = fullArgv[i+2];
                        addIndex++;
                    }
                }
                i += addIndex;
            }

            let returnDiv = $(htmlIncre);

            resolve(returnDiv[0]);

            if(argvWithoutOptions[1] == 'play'){ 
                let d, p
                if(argvWithoutOptions[2].trim().match(uuidPattern)){
                    p = getActionNameAndInputFromActivations(argvWithoutOptions[2], returnDiv);
                }
                else{
                    p = Promise.resolve({name: argvWithoutOptions[2], input: {}});
                }

                getImageDir(returnDiv)
                .then(() => p)  // data: {name, input}
                .then(data => {d = data; return getActionCode(data.name, returnDiv)})   // data: code, kind
                .then(data => {d = Object.assign({}, d, data); return init(d.kind, returnDiv)})
                .then(() => runActionInDocker(d.code, d.kind, Object.assign({}, d.input, input), returnDiv))  
                .then(data => { // data: {init_time, execution_time, result}
                    appendIncreContent('Done.', returnDiv);
                    appendIncreContent(data, returnDiv);
                    removeSpinner(returnDiv);
                })  
                .catch(e => {
                    console.log(e);
                    appendIncreContent(e, returnDiv, 'error')
                    removeSpinner(returnDiv)
                })    

            }   
            else if(argvWithoutOptions[1] == 'debug'){
                let d, p;
                //if(argvWithoutOptions[2].length == 32){ // simple check if this is an activation
                if(argvWithoutOptions[2].trim().match(uuidPattern)){
                    p = getActionNameAndInputFromActivations(argvWithoutOptions[2], returnDiv);
                }
                else{
                    p = Promise.resolve({name: argvWithoutOptions[2], input: {}});
                }

                getImageDir(returnDiv)
                .then(() => p)
                .then(data => {d = data; return getActionCode(data.name, returnDiv)})  // data: {code, kind}
                .then(data => {
                    if(data.kind.indexOf('node') == -1){
                        // not a node action - return
                        return Promise.reject('This is not a nodejs action.');
                    }
                    else{
                        data.kind = "nodejs:8";    // debugger only works for nodejs:8
                        d = Object.assign({}, d, data);
                        return init(d.kind, returnDiv);
                    }
                    
                })
                .then(() => runActionDebugger(d.code, d.kind, Object.assign({}, d.input, input), returnDiv))
                .then(data => {
                    appendIncreContent('Done.', returnDiv);
                    $(data).children().remove('.oops');
                    appendIncreContent(data, returnDiv);
                    removeSpinner(returnDiv);
                })
                .catch(e => {
                    appendIncreContent(e, returnDiv, 'error')
                    removeSpinner(returnDiv)
                });
            }
            else if(argvWithoutOptions[1] == 'init'){                
                getImageDir(returnDiv)
                .then(() => init(returnDiv))
                .then(() => {
                    appendIncreContent('Done', returnDiv)
                    removeSpinner(returnDiv);
                })
                .catch(e => {
                    appendIncreContent(e, returnDiv, 'error')
                    removeSpinner(returnDiv)
                });
            }
            else if(argvWithoutOptions[1] == 'kill'){
                appendIncreContent('Stopping and removing the container...', returnDiv);
                kill(returnDiv)
                .then(() => {
                    appendIncreContent('Done', returnDiv)
                    removeSpinner(returnDiv);
                })
                .catch(e => {
                    appendIncreContent(e, returnDiv, 'error')
                    removeSpinner(returnDiv)
                });
            }            
        }

    });
}

const getImageDir = (returnDiv) => {

    return new Promise((resolve, reject) => {
        if(_imageDir == undefined){
            repl.qexec('host get')
            .then(data => {
                if(data.indexOf('http') != 0){
                    data = 'https://'+data;
                }
                return rt({
                    method: 'get',
                    url : data,    
                    json: true
                });
            })
            .then(data => {
                console.log(data);
                _imageDir = data.body.runtimes;
                resolve(true);
            })
            .catch(e => {
                console.log(e);
                reject(e);
            });
            
        }  
        else{
            resolve(true);
        }  

    });
}

const kill = (returnDiv) => {
    return new Promise((resolve, reject) => {
        console.log('stopping the container');        
        if(_container){
            // if in this session there's a container started, remove it. 
            _container.stop()
            .then(() => _container.delete({ force: true }))
            .then(() => resolve(true))
            .catch((e => reject(e)));
        }
        else{
            // if no docker container currently recorded, we still try to kill and remove the container, in case shell crashed and left a container opened            

            let rm = false;
            repl.qexec('! docker kill shell-local')
            .then(() => {
                rm = true;  // remove is what matters. cannot open two containers with the same name
                return repl.qexec('! docker rm shell-local');
            })
            .then(() => {
                resolve(true);
            })
            .catch((e) => {
                if(!rm){
                    // if kill failed, try removing the container here again. 
                    repl.qexec('! docker rm shell-local')
                    .then(() => resolve(true))
                    .catch((e) => reject(e));
                }
                else
                    reject(e);
            });
        }                
    });
}

const init = (kind, returnDiv) => {
    return new Promise((resolve, reject) => {

        new Promise((resolve, reject) => {   

            console.log(_containerType, kind, _container)         
            
            if(_container && (_containerType && _containerType === kind)){
                // only in one condition that we will reuse a container, is in the same shell session the same kind of action being invoked 
                console.log('reuse the current container');
                resolve(dontCreateContainer);
            }
            else{
                console.log('stopping the container');
                // for all other cases, stop and delete the container, reopen a new one
                kill(returnDiv)
                .then(d => resolve(d))
                .catch(e => resolve(e));                

                // continue to the next phase no matter what: 
                // if there's any error, it will be catched when starting a container
                // delay here is small enough that it can be ignored 
            }            
        })
        .then(d => {
            if(d === dontCreateContainer){
                return Promise.resolve(d);
            }
            else{                 
                return repl.qexec('! docker image ls');
               

                //let Image = 'openwhisk/action-nodejs-v8';   // need to use kind here to get the right image
                //appendIncreContent('Starting a Docker container...', returnDiv);
                //return docker.container.create(Object.assign({Image: image}, dockerConfig))
            }            
        }) 
        .then(d => {
            if(d === dontCreateContainer){
                return Promise.resolve(d);
            }
            else{
                let image = 'openwhisk/action-nodejs-v8';
                if(_imageDir){
                    Object.keys(_imageDir).forEach(key => {
                        _imageDir[key].forEach(o => {
                            if(o.kind === kind){
                                image = o.image;
                            }
                        });
                    });
                }
                console.log('Image should used: '+image);      

                let imageLabel = image.indexOf(':latest') != -1 ? image.substring(0, image.indexOf(':latest')) : image;
                
                if($(d).html().indexOf(imageLabel) != -1){
                    console.log('Image already exist. No need to pull');
                    return Promise.all([Promise.resolve(image)]);
                }
                else{
                    appendIncreContent('Pulling the runtime docker image...', returnDiv);
                    return Promise.all([Promise.resolve(image), repl.qexec(`! docker pull ${image}`)]);
                }
            }
        })   
        .then(d => {
            if(!Array.isArray(d)){
                return Promise.resolve(d);
            }
            else{                
                appendIncreContent('Starting a Docker container...', returnDiv);
                return docker.container.create(Object.assign({Image: d[0]}, dockerConfig))
            }
        })             
        .then(d => {
            if(d === dontCreateContainer){
                return Promise.resolve(d);
            }
            else{
                _container = d; 
                _containerType = kind;            
                return _container.start(); 
            }            
        })
        .then(() => resolve(true))
        .catch((e => reject(e)));
    });
}

const getActionNameAndInputFromActivations = (actId, returnDiv) => {
    appendIncreContent('Retriving activations...', returnDiv);
    return new Promise((resolve, reject) => {
        repl.qexec(`wsk activation get ${actId}`)
        .then(d => {            
            //appendIncreContent(returnDiv, 'Retriving the action code...'); 
            console.log(d);
            let name = d.name;
            if(d.annotations && Array.isArray(d.annotations)){
                d.annotations.forEach(a => {
                    if(a.key == 'path')
                        name = a.value;
                })
            }           
            return Promise.all([name, d.cause ? repl.qexec(`wsk activation get ${d.cause}`) : undefined ])
        })
        .then(arr => {
            console.log(arr);
            let a = [arr[0]];   
            if(arr.length == 2 && arr[1] != undefined){
                console.log(arr[1].logs.indexOf(actId));
                if(arr[1].logs.indexOf(actId) > 0){
                    // get the previous activation if there's any
                    a.push(repl.qexec(`wsk activation get ${arr[1].logs[arr[1].logs.indexOf(actId)-1]}`))
                }
            }
            return Promise.all(a);
        })
        .then(arr => {          
            resolve({name: arr[0], input: arr[1] ? arr[1].response.result : {}});    
        })
        .catch(e => reject(e));
    });
        
}

const getActionCode = (actionName, returnDiv) => {
    return new Promise((resolve, reject) => {
        appendIncreContent('Retriving action code...', returnDiv);
        repl.qexec(`wsk action get ${actionName}`)
        .then(d => {
            console.log(d);
            resolve({code: d.exec.code, kind: d.exec.kind});
        })
        .catch(e => reject(e));
    });
}


const printDocs = (name) => {
    if(name && docs[name]){
        return $(docs[name])[0];
    }
    else{
        let s = $("<div></div>");
        Object.keys(docs).forEach(name => {
            //s += (docs[name] + '\n');
            $(s).append($(docs[name]));
        })
        $(s).children().css('white-space', 'pre-wrap').css('margin-bottom', '5px')
        return $(s)[0];
    }
}

const runActionInDocker = (functionCode, functionKind, functionInput, returnDiv) => {
    let start, init, run, end;
    return new Promise((resolve, reject) => {
        let p;
        if(_container && _containerCode === functionCode &&  _containerType === functionKind){
            p = Promise.resolve(skipInit);
        } 
        else{
            console.log(_container);
            appendIncreContent('Initalizing the action in container...', returnDiv);
            start = Date.now();
            p = rt({
                method: 'post',
                url : 'http://localhost:8080/' + 'init',
                agentOptions : {
                    rejectUnauthorized : false
                },
                headers : {
                'Content-Type' : 'application/json',
                },
                json : {
                    value: {
                        code: functionCode,
                        main: 'main'
                    }
                }
            })
        }
        
        p.then(() => {
            _containerCode = functionCode;
            init = Date.now();
            appendIncreContent('Running the action...', returnDiv);
            run = Date.now();
            return rt({
                method: 'post',
                url : 'http://localhost:8080/' + 'run',
                agentOptions : {
                    rejectUnauthorized : false
                },
                headers : {
                'Content-Type' : 'application/json',
                },
                json : {
                    value: functionInput
                }
            });
        })
        .then((data) => {            
            end = Date.now();
            outputData = data;
            console.log(data);
            resolve({
                init_time: start ? init-start : undefined,
                execution_time: end-run,
                response: outputData.body
            })
        })        
        .catch(error => {          
            
            if(_container && _container.stop && _container.delete){
                console.log(error);
                kill(returnDiv).then(() => {
                    appendIncreContent('Done', returnDiv);
                    reject(error);
                }).catch(e => reject(e));                                   
            }                
            else{
                console.log(error);
                reject(error);
            }
            
        });
    });
}

const runActionDebugger = (functionCode, functionKind, functionInput, returnDiv) => {
    let fileCode = `\n\n${functionCode}\n\nconsole.log('Result:');\nconsole.log(JSON.stringify(main(${JSON.stringify(functionInput)}), null, 4));\n`;

    return fs.outputFile('./'+debugFileName, fileCode)
    .then(() => repl.qexec(`! docker cp ./${debugFileName} shell-local:/nodejsAction/${debugFileName}`))
    .then(() => fs.remove('./'+debugFileName))
    .then(() => {
        appendIncreContent('Starting the debugger...', returnDiv);
        run = Date.now();
        let x = repl.qexec(`! docker exec shell-local node --inspect-brk=0.0.0.0:5858 ${debugFileName}`);

        rt({
                method: 'get',
                url : 'http://0.0.0.0:5858/json',    
                json: true

        }).then(data => {            
            console.log(data);
            if(data && data.body && data.body.length > 0 && data.body[0].devtoolsFrontendUrl){
                let backtag = data.body[0].devtoolsFrontendUrl.substring(data.body[0].devtoolsFrontendUrl.lastIndexOf('/'));
                const webview = $(`<div id="debuggerDiv" style="width:100%; height:100%"><webview src="${debuggerURL}${backtag}" style="width:100%; height:100%"></webview></div>`);

                ui.showCustom({content: $(webview)[0], sidecarHeader: false});

                $(webview).mouseup(e => {e.stopPropagation();})

                appendIncreContent('Press ESC to close the inspector after debugging...', returnDiv);
                let x = function(e){
                    if(e.keyCode == 27){    //ESC
                        $('#debuggerDiv').remove();                            
                        $(document).off('keydown', x);                            
                        console.log('remove debugger');
                    }
                }
                $(document).on('keydown', x);
            }

        })//.catch(e => reject(e));

        return x;

    })    
        
};

const appendIncreContent = (content, div, error) => {
    if(div == undefined){
        console.log('Error: content div undefined. content='+content);
        return;
    }

    if(error){
        let message = content;
        if(content.error){
            if(content.message)
                message = content.message;
            else
                message = JSON.stringify(content, null, 4);
        }        

        $(div).children('.replay_output').append(`<div style='color:red;'>${message}</div>`);
    }
    else if(typeof content === 'string')
        $(div).children('.replay_output').append(`<div>${content}</div>`);
    else if(content.response){
         $(div).children('.replay_output').append(`<div><span style="white-space:pre;">${JSON.stringify(content, null, 4)}<span></div>`);
    }
    else{        
        $(div).children('.replay_output').append(content);
    }

}

const removeSpinner = (div) => {
    $(div).children('.replay_spinner').remove();
}




