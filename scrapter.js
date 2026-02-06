/**
 * LOR Quotes Scraper - Node.js version
 * 
 * Требуемые пакеты:
 * npm install selenium-webdriver mongodb geckodriver
 * 
 * Запуск: node scraper.js
 */

const { Builder, By } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const PATTERN = /^view-quote\.php.*$/;
const DIR = "/home/uju/www.lorquotes.ru";
const user = 'lorquotesadmin';
const password = 'lorquotesapi';
const host = 'localhost:27017';
const dbName = 'lorquotes';

// Формат: mongodb://user:password@host:port/database
const MONGO_URL = `mongodb://${user}:${password}@${host}/${dbName}?authSource=admin`;

/**
 * Удаляет спецсимволы из строки (вместо экранирования)
 * Сохраняет > в начале строк (для цитирования)
 * @param {string} str - исходная строка
 * @returns {string} - очищенная строка
 */
function stripSpecialChars(str) {
    if (!str) return str;
    return str
        // Удаляем HTML-сущности (&amp; &lt; &gt; &quot; &#123; и т.д.)
        .replace(/&[a-zA-Z0-9#]+;/g, '')
        // Удаляем управляющие символы (кроме переноса строки и табуляции)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Удаляем HTML-теги
        .replace(/<[^>]*>/g, '')
        // Временно заменяем все > в начале строк на placeholder (поддержка >>, >>> и т.д.)
        .replace(/(^|\n)(>+)/gm, (match, prefix, arrows) => prefix + '\uFFFE'.repeat(arrows.length))
        // Удаляем оставшиеся < и >
        .replace(/[<>]/g, '')
        // Возвращаем > в начале строк
        .replace(/\uFFFE/g, '>');
}

/**
 * Парсит строку даты в нативный Date объект для MongoDB
 * Время во входных данных указано в MSK (UTC+3)
 * @param {string} dateStr - строка даты в формате "DD.MM.YYYY HH:MM:SS", "DD.MM.YYYY HH:MM" или "DD.MM.YYYY"
 * @returns {Date|null} - объект Date в UTC или null при ошибке
 */
function parseDate(dateStr) {
    if (!dateStr) return null;
    
    const trimmed = dateStr.trim();
    const parts = trimmed.split(/\s+/);
    const datePart = parts[0];
    const timePart = parts[1] || '00:00';
    
    // Разбираем дату DD.MM.YYYY
    const dateMatch = datePart.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!dateMatch) return null;
    
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    const year = parseInt(dateMatch[3], 10);
    
    // Разбираем время HH:MM или HH:MM:SS
    const timeMatch = timePart.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    const hours = timeMatch ? parseInt(timeMatch[1], 10) : 0;
    const minutes = timeMatch ? parseInt(timeMatch[2], 10) : 0;
    const seconds = timeMatch && timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
    
    // Валидация
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    if (seconds < 0 || seconds > 59) return null;
    
    // Создаем Date объект в UTC, учитывая что входное время в MSK (UTC+3)
    // MSK = UTC + 3 часа, поэтому вычитаем 3 часа для получения UTC
    const date = new Date(Date.UTC(year, month - 1, day, hours - 3, minutes, seconds, 0));
    
    // Проверяем валидность созданной даты
    if (isNaN(date.getTime())) return null;
    
    return date;
}

function findLQFiles(dir, pattern) {
    if (!fs.existsSync(dir)) {
        throw new Error(`Directory not found: ${dir}`);
    }
    
    const files = fs.readdirSync(dir)
        .filter(file => pattern.test(file))
        .map(file => path.join(dir, file))
        .sort((a, b) => {
            const numA = parseInt(a.split("=")[1].split(".")[0]);
            const numB = parseInt(b.split("=")[1].split(".")[0]);
            return numA - numB;
        });
    
    return files;
}

async function main() {
    // Подключение к MongoDB
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    console.log("Connected to MongoDB");
    
    const database = client.db("lorquotes");
    
    // Создание коллекции (если не существует)
    try {
        await database.createCollection("quotes");
    } catch (e) {
        await database.dropCollection("quotes");
        await database.createCollection("quotes");
    }
    
    const collection = database.collection("quotes");
    
    // Создаем индекс по дате для эффективных запросов
    await collection.createIndex({ date: 1 });
    
    // Инициализация Selenium WebDriver (Firefox)
    const options = new firefox.Options();
    //options.headless(); // Раскомментировать для headless режима
    
    const driver = await new Builder()
        .forBrowser('firefox')
        .setFirefoxOptions(options)
        .usingServer('http://localhost:4444')
        .build();
    
    try {
        const files = findLQFiles(DIR, PATTERN);
        console.log(`Found ${files.length} files to process`);
        
        for (const filePath of files) {
            try {
                // Заменяем ? на %3F в URL
                const fileUrl = "file://" + filePath.replace(/\?/g, "%3F");
                await driver.get(fileUrl);
                
                // Находим элементы
                const msgElement = await driver.findElement(By.className("q-text"));
                const signElement = await driver.findElement(By.className("q-sign"));
                
                const rawText = await msgElement.getText();
                const signText = await signElement.getText();
                const signParts = signText.split(" ");
                const userName = signParts[0];
                
                // Удаляем спецсимволы из текста (не экранируем!)
                const doc = {
                    text: stripSpecialChars(rawText),
                    user: stripSpecialChars(userName)
                };
                
                // Парсинг даты в нативный Date объект
                try {
                    let dateStr = signParts[2]?.replace(/[()]/g, "").trim();
                    if (dateStr && dateStr !== "Источник") {
                        dateStr = dateStr + " " + (signParts[3]?.replace(/[()]/g, "") || "");
                        
                        // Парсим в нативный Date объект для MongoDB
                        const nativeDate = parseDate(dateStr);
                        if (nativeDate) {
                            doc.date = nativeDate; // MongoDB сохранит как ISODate
                        } else {
                            console.warn(`Could not parse date: ${dateStr}`);
                        }
                    }
                } catch (e) {
                    console.error(`Date parsing error: ${e.message}`);
                    continue;
                }
                
                // Поиск ссылки на источник
                try {
                    const linkElement = await driver.findElement(By.linkText("Источник"));
                    const link = await linkElement.getAttribute("href");
                    doc.url = link;
                } catch (e) {
                    continue;
                }
                
                // Вставка в MongoDB
                await collection.insertOne(doc);
                console.log(`Inserted quote from ${userName} (date: ${doc.date?.toISOString() || 'N/A'})`);
                
            } catch (e) {
                console.error(`Error processing file ${filePath}:`, e.message);
                continue;
            }
        }
        
    } finally {
        await driver.quit();
        await client.close();
        console.log("Done!");
    }
}

main().catch(console.error);
