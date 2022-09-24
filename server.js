import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

import _ from 'lodash'

import flatfile from 'flat-file-db'  // docs: https://github.com/mafintosh/flat-file-db#api

import server from 'server'
import { formatTime } from './helpers.js'
const { get, post } = server.router

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let nb = path.resolve(__dirname, 'nb.js')

const db = flatfile.sync(path.join(__dirname, 'server-config.db'))

function injectScripts(...fns) {
  return `<script>${fns.map(fn => {
    if (typeof fn === 'function') return fn.toString()
    else return fn
  }).join(';')}</script>`
}

function sanitizeHtml(input) {
  return input.replace(/</g, '&#60;').replace(/>/g, '&#62;')
}

function renderBasePage(contentsOrFn = '') {
  function render() {
    try {
      let contents
      if (typeof contentsOrFn === 'function') {
        contents = contentsOrFn()
      } else {
        contents = contentsOrFn
      }
      return contents
    } catch (e) {
      console.error(e)
      return `<pre style="white-space: pre-wrap; word-break: break-word;">${e}</pre>`
    }
  }
  return `
  <head>
    <meta name="viewport" content="width=device-width, minimum-scale=1, initial-scale=1, shrink-to-fit=yes">
    <style>
      @media not all and (prefers-color-scheme: light) {
        body {
          background: black;
          color: white;
          background: rgb(35,35,35);
          color: rgb(218, 218, 218);
        }
        a {
          color: rgb(36, 190, 92);
        }
        input, textarea {
          font-family: inherit; 
          font-size: inherit; 
          background: inherit; 
          color: inherit;
        }
        button {
          background: inherit;
          color: inherit;
          border: 1px solid grey;
          border-radius: 4px;
          padding: 4px 10px;
          font-size: inherit;
          cursor: pointer;
        }
      }
    </style>
  </head>
  <body style="margin: 20px; font-size: 16px; font-family: Arial, Helvetica, sans-serif;">
    ${render()}
  </body>`
}

function renderCommandPage(ctx, commandString) {
  return renderBasePage(
    `<div style="position: sticky; background: inherit; top: 0px; padding: 1.5em 20px 0px 20px; font-size: 14px;">
      ${commandForm(`> nb.js `, commandString)}
      <hr style="border: 0; border-top: 0.5px solid gray; margin: 1.5em 0px;"/>
    </div>
    <pre id="output" style="white-space: pre-wrap; word-break: break-word; font-size: 14px;">${formatCommandOutput(ctx, commandString, sanitizeHtml(runCommand(commandString)))}</pre>`
  )
}

function commandForm(prefix, defaultValue) {
  function onInput(value) {
    document.querySelector('#spacer').innerHTML = ` ${value} `
  }

  async function doCommand(event, link) {
    event.preventDefault()
    let command = link || event.target[0].value
    let outputElement = document.querySelector('#output')
    window.history.pushState({}, '', encodeURIComponent(command))

    document.querySelector('#command-input').value = command
    onInput(command)

    let text = await (await fetch(`/nb/${encodeURIComponent(command)}`, {
      method: 'POST',
      headers: { "record-command": true }
    })).text()
    outputElement.innerHTML = formatCommandOutput({}, command, text) + '\n\n' + outputElement.innerHTML
  }

  // this hack makes the cursor move to the end of the text on focus
  function onFocus(event) {
    let val = event.target.value
    event.target.value = ''
    event.target.value = val
  }

  function addListeners() {
    window.addEventListener('keydown', (event) => {
      if (
        event.key.match(/^[a-zA-Z0-9]$/)
        && event.altKey === false
        && event.metaKey === false
        && event.ctrlKey === false
        && event.shiftKey === false
      ) {
        document.querySelector('#command-input').focus()
      }
    })
  }

  let formStyle = `style="white-space: normal; font-family: monospace; margin: -20px -20px 0px -20px;" `
  let spanStyle = `style="white-space: pre;" `
  let wrapperStyle = `style="position: relative; display: inline-block;" `
  let inputStyle = `style="position: absolute; width: 100%; left: 0; border: 0; padding: 0; margin: 0; text-align: center;" `

  return `${injectScripts(onInput, doCommand, onFocus, `(${addListeners.toString()}())`, formatCommandOutput, sanitizeHtml)}
  <form ${formStyle} onsubmit="doCommand(event)">
    <span ${spanStyle}>${prefix.trim()}</span><span ${wrapperStyle}>
      <span id="spacer" ${spanStyle}> ${defaultValue} </span>
      <input id="command-input" ${inputStyle} oninput="onInput(event.target.value)" onfocus="onFocus(event)" value="${defaultValue.replace(/"/g, '\\"')}"></input>
    </span><span ${spanStyle}></span>
  </form>`
}

function formatCommandOutput(ctx, commandString, input) {
  let isInCommandSection = false
  let commandRegExp = /(nb\.js)\s+((?:(?!&|<|\[|  ).)+)\s/

  function makeLink(link, text, help = true) {
    return `<a href="/nb/${link}${help ? ' --help' : ""}" onclick="doCommand(event, '${link}${help ? ' --help' : ""}')">${text}</a>`
  }

  let lines = input.split('\n')
    .map(line => {

      if (line.startsWith('nb.js')) {
        let parsedLine = ''
        line.split(' ').reduce((itemsSoFar, item) => {
          let isAnArg = item.startsWith('&') || item.startsWith('[')
          if (item !== 'nb.js' && !isAnArg) {
            itemsSoFar.push(item)
          }
          if (!isAnArg) {
            parsedLine += `${makeLink(itemsSoFar.join(' '), item)} `
          } else {
            parsedLine += `${item} `
          }
          return itemsSoFar
        }, [])
        return parsedLine
      }

      if (line.startsWith('Commands:')) {
        isInCommandSection = true
      }

      else if (isInCommandSection && line.startsWith('  ')) {
        return line.replace(commandRegExp, `$1 ${makeLink('$2', '$2')} `)
      }

      else if (isInCommandSection && !line.startsWith('  ')) {
        isInCommandSection = false
      }

      return line
    })
  return `> nb.js ${sanitizeHtml(commandString)}    ${makeLink(commandString, '(repeat)', false)}\n\n` + lines.join("\n")
}

function runCommand(commandString, shouldThrow = false) {
  let command = `${nb} ${commandString.split(/\s/)
    // best effort safety -- wrap all args in single quotes
    .map(part => `'${part.replace(/'/g, "'\\''")}'`).join(' ')}`
  console.log(`\n---\n> received: ${commandString}\n> running: ${command}\n`)
  let output
  try {
    output = execSync(command, { encoding: 'utf8' })
    console.log(output)
    console.log(`> command succeeded\n---\n`)
  } catch (e) {
    output = e.stdout + e.stderr
    console.log(`\n> command failed\n---\n`)
    if (shouldThrow) {
      throw output
    }
  }

  return output
}

function getCommand(ctx) {
  let commandString = ctx.params.command

  let referer = ctx.headers.referer
  let afterTheFactCommand = ctx.headers["record-command"]
  let rootReferer

  if (referer) {
    rootReferer = new URL(referer).pathname === '/'
  }

  console.log({ afterTheFactCommand, referer, rootReferer})

  if (afterTheFactCommand || !referer || rootReferer) {
    let routes = db.get('recent') || {}
    if (!routes[commandString]) routes[commandString] = 0
    Object.keys(routes).forEach(key => {
      if (key !== commandString) {
        routes[key]--;
        if (routes[key] < -20) delete routes[key]
      }
    })
    if (routes[commandString] < 0) routes[commandString] = 0
    routes[commandString] += 5;
    db.put('recent', routes)
  }

  return commandString
}

function dashboardsList() {
  let dashboards = (db.get('dashboards') || {})

  return `dashboards (<a href="/dashboards/add">add new</a>)` +
    Object.keys(dashboards).map(dashboardName => {
      return `<br />- <a href="/dashboards/${dashboardName}">${dashboardName}</a>  (<a href="/dashboards/${dashboardName}/edit">edit</a>) (<a href="/dashboards/${dashboardName}/delete" onClick="confirm('Are you sure you want to delete ${dashboardName}?') || event.preventDefault()">delete</a>)`
    }).join('')
}

function viewDashboardPage(ctx, dashboardName) {
  let dashboard = (db.get('dashboards') || {})[dashboardName]

  if (!dashboard) {
    return `No dashboard called ${dashboardName} found.`
  }

  let sources = {}
  let variables = []
  Object.entries(dashboard.variables).forEach(([variable, details]) => {
    let normalizedSource = details.source.trim()
    let source = sources[normalizedSource]

    if (!source) {
      source = runCommand(normalizedSource, true)
      try {
        source = JSON.parse(source)
      } catch (e) { } // ignore

      if (source.values) {
        source.values = source.values.map(valueObject => {
          let [index, time, value, ...tags] = valueObject
          valueObject.index = index
          valueObject.time = time
          valueObject.value = value
          valueObject.tags = tags
          return valueObject
        })
      }
    }

    let value = details.path ? _.get(source, details.path) : source
    if (details.type === 'time') {
      value = formatTime(value, details.format || 'relative')
    } if (details.type === 'preformatted') {
      value = `<pre>${value}</pre>`
    }
    variables.push({
      name: variable,
      value
    })
  })

  return dashboard.template.map(section => {
    if (section.type === 'table') return viewTable(section.data, variables)
    else {
      console.log('nope', section)
      return JSON.stringify(section)
    }
  }).join('')
}

function viewTable(data, variables) {
  return `<table>${data.map((row, rowIndex) => {
    return `<tr>${row.map(cell => {
      return `<td style="${rowIndex !== 0 ? 'border-top: 1px solid grey;' : ''} padding: 6px;">${injectVariables(cell, variables)}</td>`
    }).join('')}</tr>`
  }).join('')}</table>`
}

function injectVariables(text, variables) {
  variables.forEach(({ name, value }) => {
    text = text.replace(new RegExp('\\${' + name + '}', 'g'), value)
  })
  return text
}

function editDashboardPage(ctx, dashboardName) {
  let dashboard = dashboardName ? (db.get('dashboards') || {})[dashboardName] : undefined

  return renderBasePage(
    `<form style="font-size: 17px; padding: 20px;" action="/dashboards" method="POST">
      <label style="line-height: 2em;">
        dashboard name
        <br>
        <input name="name" value="${dashboard ? dashboardName : ''}" style="width: 90vw; border: 1px dashed grey; border-radius: 5px; font-size: inherit;"></input>
      </label>
      <br>
      <br>
      <label style="line-height: 2em;">
        dashboard config
        <textarea name="config" style="width: 90vw; height: 70vh; border: 1px dashed grey; border-radius: 5px; font-size: inherit;">${dashboard ? JSON.stringify(dashboard, null, 2) : ''}</textarea>
      </label>
      <br>
      <button>save</button>
    </form>`
  )
}

const port = 8080

// because we're trying to be shape-agnostic, we don't care what the args are called so long as they exist
// this functions makes handler routes for both the --help and the regular commands for a certain length

server({ port, security: { csrf: false } }, [
  get('/', ctx => {
    let recents = db.get('recent')
    let recentsText = ''
    if (recents) {
      recentsText = Object.entries(recents)
        .sort((a, b) => b[1] - a[1]).map(([key, weight]) => {
          return `- (${weight}) <a href="nb/${key}">${key}</a>`
        })
        .join('<br />')
    }

    return renderBasePage(
      `<a href="nb/--help">nb</a><br />${recentsText}<br /><br />${dashboardsList()}`
    )
  }),

  get('/nb', ctx => renderCommandPage(ctx, '')),
  post('/nb', ctx => server.reply
    .type("text/plain")
    .send(runCommand(''))),

  get('/nb/:command', ctx => renderCommandPage(ctx, getCommand(ctx))),
  post('/nb/:command', ctx => {
    return server.reply
      .type("text/plain")
      .send(runCommand(getCommand(ctx)))
  }),

  get('/dashboards', ctx => renderBasePage(dashboardsList())),
  get('/dashboards/add', ctx => editDashboardPage(ctx)),
  get('/dashboards/:dashboard', ctx => renderBasePage(() => viewDashboardPage(ctx, ctx.params.dashboard))),
  get('/dashboards/:dashboard/edit', ctx => editDashboardPage(ctx, ctx.params.dashboard)),
  post('/dashboards', ctx => {
    let dashboards = db.get('dashboards') || {}
    db.put('dashboards', {
      ...dashboards,
      [ctx.data.name]: JSON.parse(ctx.data.config)
    })
    return server.reply.redirect(`/dashboards/${ctx.data.name}`)
  }),
  get('/dashboards/:dashboard/delete', ctx => {
    let dashboards = db.get('dashboards') || {}
    delete dashboards[ctx.params.dashboard]
    db.put('dashboards', dashboards)
    return server.reply.redirect(`/dashboards`)
  }),

  get('*', (ctx) => {
    return ''
  })

],
  server.router.error(ctx => {
    console.log(ctx.error)
    return server.reply.status(500).send(ctx.error.message)
  })
);

console.log(`Listening on http://localhost:${port}`)