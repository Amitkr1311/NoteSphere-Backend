import type { NextFunction, Request,Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken"
import { JWT_PASSWORD } from "./jwt_password.ts";

export const userMiddleware = (req:Request, res: Response, next: NextFunction) => {
    let header = req.headers["authorization"];

    if (!header) {
        res.status(401).json({
            message: "Authorization header missing"
        });
        return;
    }

    // Handle string | string[] and strip "Bearer " prefix
    const token = Array.isArray(header) ? header[0] : header;
    const finalToken = token.startsWith("Bearer ") ? token.slice(7) : token;

    try {
        const decoded = jwt.verify(finalToken, JWT_PASSWORD) as JwtPayload;
        // decoded is the user_id of the use from the database
        if(decoded && decoded.id) {
            req.userId = decoded.id;
            next();
        }
        else{
            res.status(403).json({
                message: "You are not logged in"
            })
        }
    } catch (error) {
        res.status(403).json({
            message: "Invalid or expired token"
        });
    }
}