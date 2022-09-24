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

function renderBasePage(contents = '') {
  return `<head><meta name="viewport" content="width=device-width, minimum-scale=1, initial-scale=1, shrink-to-fit=yes"></head>`
    + `<body style="font-size: 13px; margin: 0px;">`
    + contents
    + `</body>`
} 

function renderCommandPage(ctx, commandString) {
  return renderBasePage(
    '<div style="position: sticky; background: white; top: 0px; padding: 1.3em 10px 0px 10px;">'
    + commandForm(`> nb.js `, commandString)
    + '<hr style="border: 0; border-top: 0.5px solid gray; margin: 1.5em 0px;"/>'
    + `</div>`
    + `<pre id="output" style="margin: 10px; white-space: pre-wrap; word-break: break-word;">${formatCommandOutput(ctx, commandString, sanitizeHtml(runCommand(commandString)))}</pre>`
  )
}

function renderStaticPage(ctx, commandString) {
  return renderBasePage(
    `<pre id="output" style="margin: 10px; white-space: pre-wrap; word-break: break-word;">${sanitizeHtml(runCommand(commandString))}</pre>`
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

    let text = await (await fetch(`/nb/${encodeURIComponent(command)}`, { method: 'POST' })).text()
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
      console.log(event)
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

  let formStyle = `style="white-space: normal; font-family: monospace;" `
  let spanStyle = `style="white-space: pre;" `
  let wrapperStyle = `style="position: relative; display: inline-block;" `
  let inputStyle = `style="position: absolute; width: 100%; left: 0; border: 0; padding: 0; margin: 0; font-family: inherit; font-size: inherit; text-align: center;" `

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

function runCommand(commandString) {
  let command = `${nb} ${commandString.split(/\s/)
    // best effort safety -- wrap all args in single quotes
    .map(part => `'${part.replace(/'/g, "'\\''")}'`).join(' ')}`
  let output
  try {
    output = execSync(command, { encoding: 'utf8' })
  } catch (e) {
    output = e.stdout + e.stderr
  }

  console.log(`> ${command}`)
  console.log(output)

  return output
}

function getCommand(ctx) {
  let commandString = ctx.params.command

  let routes = db.get('recent') || {}
  if (!routes[commandString]) routes[commandString] = 0
  Object.keys(routes).forEach(key => {
    if (key !== commandString) {
      routes[key]--;
      if (routes[key] < 0) delete routes[key]
    }
  })
  routes[commandString] += 4;
  db.put('recent', routes)

  return commandString
}

function listDashboardsPage() {
  let dashboards = (db.get('dashboards') || {})

  return renderBasePage(
    `<a href="/dashboard/edit">add</a>` +
    Object.keys(dashboards).map(dashboardName => {
      return `<br /><a href="/dashboard/${dashboardName}">${dashboardName}</a>`
    }).join('')
  )
}

function viewDashboardPage(ctx, dashboardName) {
  let dashboard = (db.get('dashboards') || {})[dashboardName]

  if (!dashboard) {
    return renderBasePage(
      `No dashboard called ${dashboardName} found.`
    )
  }

  let sources = {}
  Object.entries(dashboard.sources).forEach(([source, command]) => {
    sources[source] = JSON.parse(runCommand(`stream show ${command} --format json`))
  })

  let variables = []
  Object.entries(dashboard.variables).forEach(([variable, details]) => {
    let value = _.get(sources[details.source], details.path)
    if (details.type === 'time') {
      value = formatTime(value, details.format || 'relative')
    }
    variables.push({
      name: variable,
      value
    })
  })

  return renderBasePage(
    `<div style="font-size: 17px; padding: 20px; font-family: Arial, sans-serif;">
      ${dashboard.template.map(section => {
        if (section.type === 'table') return viewTable(section.data, variables)
        else {
          console.log('nope', section)
          return JSON.stringify(section)
        }
      }).join('')}
    </div>`
  )
}

function viewTable(data, variables) {
  return `<table>${data.map((row, rowIndex) => {
    return `<tr>${row.map(cell => {
      return `<td style="${rowIndex !== 0 ? 'border-top: 1px solid grey;' : ''} padding: 6px;">${injectVariables(cell, variables)}</td>`
    }).join('')}</tr>`
  }).join('')}</table>`
}

function injectVariables(text, variables) {
  variables.forEach(({name, value}) => {
    text = text.replace(new RegExp('\\${'+name+'}', 'g'), value)
  })
  return text
}

function editDashboardPage(ctx, dashboardName) {
  let dashboard = dashboardName ? (db.get('dashboards') || {})[dashboardName] : undefined

  return renderBasePage(
    `<form style="font-size: 17px; padding: 20px;" action="/dashboard" method="POST">
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
        .sort((a, b) => b[1] - a[1]).map(([key]) => {
          return `- <a href="nb/${key} --help">${key}</a>`
        })
        .join('<br />')
    }

    return `<a href="nb/--help">nb</a><br />${recentsText}`
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

  get('/dashboard', ctx => listDashboardsPage(ctx)),
  get('/dashboard/:dashboard', ctx => viewDashboardPage(ctx, ctx.params.dashboard)),
  get('/dashboard/edit', ctx => editDashboardPage(ctx)),
  get('/dashboard/edit/:dashboard', ctx => editDashboardPage(ctx, ctx.params.dashboard)),
  post('/dashboard', ctx => {
    // console.log(ctx.data, ctx.params, ctx.query)
    let dashboards = db.get('dashboards') || {}
    db.put('dashboards', {
      ...dashboards,
      [ctx.data.name]: JSON.parse(ctx.data.config)
    })
    return server.reply.redirect(`/dashboard/${ctx.data.name}`)
  }),

],
  server.router.error(ctx => {
    console.log(ctx.error)
    return server.reply.status(500).send(ctx.error.message)
  })
);

console.log(`Listening on http://localhost:${port}`)