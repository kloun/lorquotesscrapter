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
        // Коллекция уже существует
    }
    
    const collection = database.collection("quotes");
    
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
                
                const text = await msgElement.getText();
                const signText = await signElement.getText();
                const signParts = signText.split(" ");
                const user = signParts[0];
                
                const doc = {
                    text: text,
                    user: user
                };
                
                // Парсинг даты
                try {
                    let date = signParts[2]?.replace(/[()]/g, "").trim();
                    if (date && date !== "Источник") {
                        date = date + " " + (signParts[3]?.replace(/[()]/g, "") || "");
                        doc.date = date.trim();
                    }
                } catch (e) {
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
                console.log(`Inserted quote from ${user}`);
                
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