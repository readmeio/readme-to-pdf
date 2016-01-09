/**
 * Created by roman on 01.12.15.
 */
var cheerio = require('cheerio'),
    fs = require('fs'),
    Promise = require('bluebird'),
    links = require('./links.json'),
    exec = require('child_process').exec,
    request = Promise.promisifyAll(require('request'), {multiArgs: true});

var url = "http://apacheignite.gridgain.org";

var renderResult = function (page) {
    var blocks = page.blocks;
    var resultPage = page.templ;
    for (var i = 0; i < blocks.length; i++) {
        resultPage = resultPage.replace('[#[' + i + ']#]', blocks[i]);
    }
    resultPage = resultPage.replace(/<sup>|<\/sup>/g, '^');
    resultPage = resultPage.replace(/##/g, '==== ');
    resultPage = resultPage.replace(/#\s/g, '#');
    return resultPage.replace(/\n\s*\*/g, '\n\n*');

};

var toCallout = function (callout) {
    var type = {'success': 'TIP: ', 'warning': 'WARNING: ', 'info': 'NOTE: '};
    var result = type[callout.type];
    if (callout.hasOwnProperty('title')) {
        result += '*' + callout.title + '.*\n';
    }
    return result + callout.body + '\n';
};

var toCode = function (code) {
    var result = '';
    code = code.codes;
    for (var i = 0; i < code.length; i++) {
        result += '[source,' + code[i].language + ']\n';
        if (code[i].hasOwnProperty('name') && code[i].name !== undefined && code[i].name !== '' && code[i].name !== ' ') {
            result += '.' + code[i].name + '\n';
        }
        result += '----\n';
        result += code[i].code;
        result += '\n----\n\n';
    }
    return result;
};

var toHeader = function (header) {
    return '==== ' + header.title + '\n' + "'''" + '\n';
};


var toTable = function (table) {
    var result = '[cols="' + table.cols + '*", options="header"]\n';
    result += '|===\n';
    var i = 1;
    for (var cell in table.data) {
        if (table.data.hasOwnProperty(cell)) {
            result += '|' + table.data[cell] + '\n';
            if (i % table.cols == 0) {
                result += '\n';
            }
        }
        i++;
    }
    return result + '|===\n';
};

var getImage = function (images) {
    var result = '';
    images = images.images;
    for (var i = 0; i < images.length; i++) {
        var image = 'image::' + images[i].image[0] +
            '[caption="' + images[i].caption +
            '", align="center", link="' + images[i].image[0] +
            '"]\n';
        result += image;
    }
    return result;
};

var processBlock = function (struct, type) {
    var templ = [];
    switch (type) {
        case 'callout':
            templ.push(toCallout(struct));
            break;
        case 'code':
            templ.push(toCode(struct));
            break;
        case 'api-header':
            templ.push(toHeader(struct));
            break;
        case 'parameters':
            templ.push(toTable(struct));
            break;
        case 'image':
            templ.push(getImage(struct));
            break;
    }
    return Promise.all(templ);
};

var setLinks = function (str) {
    var before = str.match(/\[.*\]\((doc:|http|#).*\)/),
        after = '';
    if (before) {
        var splittedLink = before[0].split(/\[|\]/);
        var title = splittedLink[1];
        var link = splittedLink[2].split(/\(|\)/)[1];
        if (!/doc:|^#/.test(link)) {
            after = 'link:' + link + '[' + title + ']';
        } else {
            link = link.split(/doc:|^#/)[1];
            after = '<<' + links[link] + '>>';
        }
        return str.replace(before[0], after);
    }
    return str;
};

var blocksToAsciidoc = function (page) {
    var doc = page.doc.split('\n');
    var blockOpen = false;
    var blockType = '';
    var json = '';
    var result = '\n=== ' + page.title + "\n" + page.notification + "\n\n'''\n";
    if (page.addParagraph) result = '\n<<<\n== ' + page.paragraph + '\n<<<\n' + result;
    var blockCounter = 0;
    var arrayOfFunk = [];
    for (var i = 0; i < doc.length; i++) {
        doc[i] = setLinks(doc[i]);
        if (doc[i].match(/\[block:\S*\]/)) {
            blockType = doc[i].split(/(\[block:|\])/)[2];
            blockOpen = true;
            continue;
        }
        if (doc[i] === '[/block]') {
            json = json.replace(/,(\s*|\n*)}/, '}');
            var blockStructure = JSON.parse(json);
            json = '';
            result += '\n[#[' + blockCounter + ']#]';
            blockCounter++;
            arrayOfFunk.push(processBlock(blockStructure, blockType));
            blockOpen = false;
        } else {
            if (blockOpen && !(/\w\": (null|undefined)/.test(doc[i]))) {
                json += doc[i];
            }
            if (!blockOpen) {
                result += doc[i] + '\n';
            }
        }
    }
    return Promise.all(arrayOfFunk).then(function (blocks) {
        return {blocks: blocks, templ: result, doc: page.doc};
    });
};


var structurizeDoc = function (page) {
    var $ = cheerio.load(page.body);
    var doc = $('body').find('.docs-content')[0];
    var header = $(doc).find('.docs-header')[0];
    return blocksToAsciidoc({
        title: $(header).find('h1').text(),
        notification: $(header).find('h1').next().text(),
        doc: $('.docs-body').find('content').text(),
        paragraph: page.paragraph,
        addParagraph: page.addParagraph
    });
};


var cleanSubPage = function (data) {
    for (var i = 0; i < data.length; i++) {
        data[i] = structurizeDoc(data[i]);
    }
    return Promise.all(data);
};

var getSubPage = function (data) {
    return request.getAsync(data.link).spread(function (response, body) {
        if (response.statusCode !== 200) {
            throw new Error("Error, code:" + response.statusCode);
        }
        data['body'] = body;
        return data;
    });
};

var getLisOfSubPages = function ($) {
    var toc = $('.sidebar-nav').find('h4');
    var result = [];
    var addParagraph = true;
    fs.writeFile('tmp.adoc', ':icons: font\n:source-highlighter: coderay\n:toc:\n= Apache Ignite^tm^\n\n');
    toc.each(function (i, elem) {
        addParagraph = true;
        var paragraph = $(elem).text();
        var list = $(elem).next().find('a');
        list.each(function (i, link) {
            var pageInfo = {};
            pageInfo['link'] = url + $(link).attr('href');

            pageInfo['text'] = $(link).text();
            pageInfo['paragraph'] = paragraph;
            pageInfo['addParagraph'] = addParagraph;
            addParagraph = false;
            return result.push(getSubPage(pageInfo));
        });
    });
    return Promise.all(result);
};


request.getAsync("http://apacheignite.gridgain.org/docs/ignite-life-cycle").spread(function (response, body) {
        if (response.statusCode !== 200) {
            throw new Error("Error, code: " + response.statusCode);
        }
        return cheerio.load(body);
    })
    .then(getLisOfSubPages)
    .then(cleanSubPage)
    .then(function (pages) {
        var renders = [];
        for (var i = 0; i < pages.length; i++) {
            renders.push(renderResult(pages[i]));
        }
        return Promise.all(renders);
    })
    .then(function (pages) {
        for (var i = 0; i < pages.length; i++) {
            fs.appendFile('tmp.adoc', pages[i] + '\n');
        }
    })
    .then(function () {
         exec("asciidoctor-pdf -a allow-uri-read -a toc  tmp.adoc", function(error, stdout, stderr){
            console.log('pdf rendered');
            exec('rm tmp.adoc');
        })
    })
    .catch(function (error) {
        console.log(error.stack);
    });


